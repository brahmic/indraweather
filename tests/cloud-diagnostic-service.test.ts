import { describe, expect, it, vi } from "vitest";
import { CloudDiagnosticService } from "../src/application/cloud-diagnostic-service.js";

describe("CloudDiagnosticService", () => {
  it("caches the diagnostic base but redraws the current wind overlay", async () => {
    const observedAt = new Date("2026-07-13T09:50:00Z");
    const images = {
      getLatestMetadata: vi.fn(async () => ({ observedAt })),
      getImage: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" as const })),
      getCoastline: vi.fn(async () => []),
    };
    const coastline = { apply: vi.fn(async (data: Uint8Array) => data) };
    const windOverlay = { apply: vi.fn(async (data: Uint8Array) => data) };
    const service = new CloudDiagnosticService(
      images as never,
      coastline as never,
      windOverlay as never,
      {
        latitude: 66,
        longitude: 33,
        timeZone: "Europe/Moscow",
        cacheMinutes: 10,
        cacheMaxEntries: 4,
      },
    );

    const now = new Date("2026-07-13T10:00:00Z");
    await service.getLatest(now);
    await service.getLatest(new Date(now.getTime() + 60_000));

    expect(images.getLatestMetadata).toHaveBeenCalledOnce();
    expect(coastline.apply).toHaveBeenCalledOnce();
    expect(windOverlay.apply).toHaveBeenCalledTimes(2);
  });
});
