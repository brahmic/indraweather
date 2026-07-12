import { describe, expect, it, vi } from "vitest";
import { SatelliteImageService } from "../src/application/satellite-image-service.js";
import type { EumetviewClient, SatelliteLayer } from "../src/infrastructure/eumetview.js";

const dayLayer: SatelliteLayer = { name: "day", mode: "day" };
const nightLayer: SatelliteLayer = { name: "night", mode: "night" };

describe("SatelliteImageService", () => {
  it("selects daylight imagery and caches the result", async () => {
    const observedAt = new Date("2026-07-11T09:50:00Z");
    const client = stubClient(observedAt);
    const service = createService(client);
    const now = new Date("2026-07-11T10:00:00Z");

    const first = await service.getLatest(now);
    const second = await service.getLatest(new Date(now.getTime() + 60_000));

    expect(first.filename).toContain("day");
    expect(first.caption).toContain("EUMETSAT EUMETView");
    expect(second).toBe(first);
    expect(client.getLatestMetadata).toHaveBeenCalledTimes(1);
    expect(client.getLatestMetadata).toHaveBeenCalledWith(dayLayer);
  });

  it("selects infrared imagery in polar night", async () => {
    const observedAt = new Date("2026-01-11T00:50:00Z");
    const client = stubClient(observedAt);
    const service = createService(client);
    const image = await service.getLatest(new Date("2026-01-11T01:00:00Z"));
    expect(image.filename).toContain("night");
    expect(client.getLatestMetadata).toHaveBeenCalledWith(nightLayer);
  });

  it("uses an infrared frame for animation even during daylight", async () => {
    const observedAt = new Date("2026-07-11T09:50:00Z");
    const client = stubClient(observedAt);
    const service = createService(client);

    await service.getLatestInfrared(new Date("2026-07-11T10:00:00Z"));

    expect(client.getLatestMetadata).toHaveBeenCalledWith(nightLayer);
  });

  it("rejects stale imagery", async () => {
    const client = stubClient(new Date("2026-07-11T05:00:00Z"));
    const service = createService(client);
    await expect(service.getLatest(new Date("2026-07-11T10:00:00Z"))).rejects.toThrow(/minutes old/u);
  });
});

function createService(client: ReturnType<typeof stubClient>) {
  return new SatelliteImageService(
    client as unknown as EumetviewClient,
    {
      apply: vi.fn(async (image: Uint8Array) => image),
    } as never,
    {
      apply: vi.fn(async (image: Uint8Array) => image),
    } as never,
    {
      latitude: 66,
      longitude: 33,
      maxAgeMinutes: 90,
      cacheMinutes: 10,
      timeZone: "Europe/Moscow",
    },
  );
}

function stubClient(observedAt: Date) {
  return {
    dayLayer,
    nightLayer,
    getLatestMetadata: vi.fn(async () => ({ observedAt })),
    getImage: vi.fn(async () => ({
      data: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png" as const,
    })),
    getCoastline: vi.fn(async () => [[[30, 64], [36, 68]]]),
  };
}
