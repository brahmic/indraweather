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
});
