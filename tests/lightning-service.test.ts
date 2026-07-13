import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { LightningService } from "../src/application/lightning-service.js";

describe("LightningService", () => {
  it("renders recent LI flashes on the coastline map and caches a viewport query", async () => {
    const flashes = [{
      observedAt: new Date(),
      latitude: 65,
      longitude: 34,
    }];
    const client = { getFlashes: vi.fn(async () => flashes) };
    const coastlineSource = {
      getCoastline: vi.fn(async () => [[[30, 64], [36, 68]]]),
      withViewport: vi.fn(),
    };
    coastlineSource.withViewport.mockReturnValue(coastlineSource);
    const coastline = {
      apply: vi.fn(async (image: Uint8Array) => image),
      withViewport: vi.fn(),
    };
    coastline.withViewport.mockReturnValue(coastline);
    const service = new LightningService(
      client as never,
      coastline as never,
      coastlineSource as never,
      [{ id: "kem", name: "Кемь", shortName: "Кемь", latitude: 65, longitude: 34, order: 1, active: true }],
      {
        bbox: [30, 64, 36, 68],
        width: 1_000,
        height: 800,
        maxImageBytes: 1_000_000,
        windowMinutes: 30,
        cacheMinutes: 5,
        cacheMaxEntries: 4,
        timeZone: "Europe/Moscow",
      },
    );

    const first = await service.getLatest();
    const second = await service.getLatest();
    const { data, info } = await sharp(first.data).raw().toBuffer({ resolveWithObject: true });
    const marker = (600 * info.width + 667) * info.channels;

    expect(first.filename).toMatch(/^lightning-.*\.png$/u);
    expect(first.caption).toContain("Зарегистрировано вспышек: 1");
    expect(first.caption).toContain("Ближайшая к Кемь: 0 км");
    expect(second.data).toEqual(first.data);
    expect(client.getFlashes).toHaveBeenCalledOnce();
    expect(coastline.apply).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(Array));
    expect([...data.subarray(marker, marker + 3)]).toEqual([255, 82, 82]);
  });

  it("states explicitly when no LI flashes were observed", async () => {
    const service = new LightningService(
      { getFlashes: vi.fn(async () => []) } as never,
      { apply: vi.fn(async (image: Uint8Array) => image) } as never,
      { getCoastline: vi.fn(async () => [[[30, 64], [36, 68]]]) } as never,
      [],
      {
        bbox: [30, 64, 36, 68], width: 1_000, height: 800, maxImageBytes: 1_000_000,
        windowMinutes: 30, cacheMinutes: 5, cacheMaxEntries: 4, timeZone: "Europe/Moscow",
      },
    );

    await expect(service.getLatest()).resolves.toMatchObject({
      caption: expect.stringContaining("Вспышек в текущем охвате не зарегистрировано"),
    });
  });

  it("uses a dimmed current satellite image as the LI map background", async () => {
    const satelliteData = new Uint8Array(await sharp({
      create: { width: 1_000, height: 800, channels: 3, background: "#ffffff" },
    }).png().toBuffer());
    const satellite = {
      getLatest: vi.fn(async () => ({
        data: satelliteData,
        observedAt: new Date("2026-07-13T10:00:00Z"),
      })),
    };
    const coastline = { apply: vi.fn(async (image: Uint8Array) => image) };
    const coastlineSource = { getCoastline: vi.fn(async () => [[[30, 64], [36, 68]]]) };
    const service = new LightningService(
      { getFlashes: vi.fn(async () => []) } as never,
      coastline as never,
      coastlineSource as never,
      [],
      {
        bbox: [30, 64, 36, 68], width: 1_000, height: 800, maxImageBytes: 1_000_000,
        windowMinutes: 30, cacheMinutes: 5, cacheMaxEntries: 4, timeZone: "Europe/Moscow",
      },
      satellite as never,
    );

    const image = await service.getLatest();
    const { data, info } = await sharp(image.data).raw().toBuffer({ resolveWithObject: true });
    const background = (400 * info.width + 800) * info.channels;

    expect(satellite.getLatest).toHaveBeenCalledWith(expect.any(Date), undefined);
    expect(coastline.apply).not.toHaveBeenCalled();
    expect(image.caption).toContain("Спутниковая подложка: EUMETView");
    expect(data[background]).toBeLessThan(220);
  });

  it("falls back to the coastline map when the satellite image is unavailable", async () => {
    const satellite = { getLatest: vi.fn(async () => { throw new Error("EUMETView down"); }) };
    const coastline = { apply: vi.fn(async (image: Uint8Array) => image) };
    const logger = { warn: vi.fn() };
    const service = new LightningService(
      { getFlashes: vi.fn(async () => []) } as never,
      coastline as never,
      { getCoastline: vi.fn(async () => [[[30, 64], [36, 68]]]) } as never,
      [],
      {
        bbox: [30, 64, 36, 68], width: 1_000, height: 800, maxImageBytes: 1_000_000,
        windowMinutes: 30, cacheMinutes: 5, cacheMaxEntries: 4, timeZone: "Europe/Moscow",
      },
      satellite as never,
      logger as never,
    );

    const image = await service.getLatest();

    expect(coastline.apply).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Lightning satellite background unavailable; using cartographic fallback",
    );
    expect(image.caption).toContain("Спутниковая подложка временно недоступна");
  });
});
