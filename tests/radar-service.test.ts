import { describe, expect, it, vi } from "vitest";
import { RadarService } from "../src/application/radar-service.js";

describe("RadarService", () => {
  it("caches the Sentinel-1 base but redraws the current wind overlay", async () => {
    const observedAt = new Date("2026-07-13T09:30:00Z");
    const radar = {
      getLatest: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), observedAt })),
    };
    const coastline = { apply: vi.fn(async (data: Uint8Array) => data) };
    const coastlineSource = { getCoastline: vi.fn(async () => []) };
    const windOverlay = { apply: vi.fn(async (data: Uint8Array) => data) };
    const service = new RadarService(
      radar as never,
      coastline as never,
      coastlineSource as never,
      windOverlay as never,
      "Europe/Moscow",
      { cacheMinutes: 30, cacheMaxEntries: 4 },
    );

    await service.getLatest();
    await service.getLatest();

    expect(radar.getLatest).toHaveBeenCalledOnce();
    expect(coastline.apply).toHaveBeenCalledOnce();
    expect(windOverlay.apply).toHaveBeenCalledTimes(2);
  });
});
