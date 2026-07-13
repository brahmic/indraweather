import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  DetailedSatelliteService,
  imageCoveragePercent,
} from "../src/application/detailed-satellite-service.js";

describe("imageCoveragePercent", () => {
  it("measures coverage from the WMS alpha channel", async () => {
    const image = await sharp(Buffer.from([
      255, 0, 0, 255, 255, 0, 0, 0,
      255, 0, 0, 255, 255, 0, 0, 0,
    ]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    expect(await imageCoveragePercent(new Uint8Array(image))).toBe(50);
  });
});

describe("DetailedSatelliteService", () => {
  it("returns a reason and next pass when coverage is below the limit", async () => {
    const image = await sharp(Buffer.from([
      255, 0, 0, 255, 255, 0, 0, 0,
      255, 0, 0, 0, 255, 0, 0, 0,
    ]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    const observedAt = new Date("2026-07-11T08:00:00Z");
    const nextPassAt = new Date("2026-07-11T18:30:00Z");
    const service = new DetailedSatelliteService(
      { findProducts: vi.fn(async () => [{ id: "S3A", platform: "Sentinel-3A", observedAt }]) } as never,
      { getImage: vi.fn(async () => ({ data: new Uint8Array(image), contentType: "image/png" })) } as never,
      {} as never,
      {} as never,
      { nextPass: vi.fn(async () => nextPassAt) } as never,
      {
        maxAgeHours: 12,
        minCoveragePercent: 70,
        preferredCoveragePercent: 70,
        cacheMinutes: 30,
        maxImageBytes: 9_000_000,
        timeZone: "Europe/Moscow",
      },
    );

    const result = await service.getLatest(new Date("2026-07-11T10:00:00Z"));

    expect(result).toEqual({
      status: "skipped",
      reason: { code: "low-coverage", coveragePercent: 25, minCoveragePercent: 70 },
      nextPassAt,
    });
  });

  it("keeps a partial frame and reports when a better pass is expected", async () => {
    const image = await sharp(Buffer.from([
      255, 0, 0, 255, 255, 0, 0, 0,
      255, 0, 0, 0, 255, 0, 0, 0,
    ]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    const observedAt = new Date("2026-07-11T08:00:00Z");
    const nextPassAt = new Date("2026-07-11T18:30:00Z");
    const coastline = { apply: vi.fn(async (data: Uint8Array) => data) };
    const wind = { apply: vi.fn(async (data: Uint8Array) => data) };
    const service = new DetailedSatelliteService(
      { findProducts: vi.fn(async () => [{ id: "S3A", platform: "Sentinel-3A", observedAt }]) } as never,
      {
        getImage: vi.fn(async () => ({ data: new Uint8Array(image), contentType: "image/png" })),
        getCoastline: vi.fn(async () => []),
      } as never,
      coastline as never,
      wind as never,
      { nextPass: vi.fn(async () => nextPassAt) } as never,
      {
        maxAgeHours: 12,
        minCoveragePercent: 20,
        preferredCoveragePercent: 70,
        cacheMinutes: 30,
        maxImageBytes: 9_000_000,
        timeZone: "Europe/Moscow",
      },
    );

    const result = await service.getLatest(new Date("2026-07-11T10:00:00Z"));

    expect(result).toMatchObject({
      status: "available",
      coveragePercent: 25,
      partial: { preferredCoveragePercent: 70, nextPassAt },
    });
    expect(coastline.apply).toHaveBeenCalledOnce();
    expect(wind.apply).toHaveBeenCalledOnce();
  });

  it("adds the Sentinel-3 flight and partial-coverage marker onto a detailed image", async () => {
    const width = 400;
    const height = 240;
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width / 2; x += 1) {
        const pixel = (y * width + x) * 4;
        raw[pixel] = 80;
        raw[pixel + 1] = 120;
        raw[pixel + 2] = 130;
        raw[pixel + 3] = 255;
      }
    }
    const image = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const observedAt = new Date("2026-07-11T08:00:00Z");
    const coastline = { apply: vi.fn(async (data: Uint8Array) => data) };
    const wind = { apply: vi.fn(async (data: Uint8Array) => data) };
    const service = new DetailedSatelliteService(
      { findProducts: vi.fn(async () => [{ id: "S3A", platform: "Sentinel-3A", observedAt }]) } as never,
      {
        getImage: vi.fn(async () => ({ data: new Uint8Array(image), contentType: "image/png" })),
        getCoastline: vi.fn(async () => []),
      } as never,
      coastline as never,
      wind as never,
      { nextPass: vi.fn(async () => new Date("2026-07-11T18:30:00Z")) } as never,
      {
        maxAgeHours: 12,
        minCoveragePercent: 20,
        preferredCoveragePercent: 70,
        cacheMinutes: 30,
        maxImageBytes: 9_000_000,
        timeZone: "Europe/Moscow",
      },
    );

    const result = await service.getLatest(new Date("2026-07-11T10:00:00Z"));

    expect(result).toMatchObject({ status: "available", partial: expect.any(Object) });
    if (result.status !== "available") throw new Error("Expected detailed image");
    const { data } = await sharp(result.attachment.data).raw().toBuffer({ resolveWithObject: true });
    const panelPixel = (190 * width + 20) * 4;
    const warningPixel = (184 * width + 365) * 4;
    expect([...data.subarray(panelPixel, panelPixel + 3)]).not.toEqual([80, 120, 130]);
    expect([...data.subarray(warningPixel, warningPixel + 3)]).not.toEqual([80, 120, 130]);
  });
});
