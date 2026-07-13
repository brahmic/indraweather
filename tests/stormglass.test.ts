import { afterEach, describe, expect, it, vi } from "vitest";
import { StormglassClient } from "../src/infrastructure/stormglass.js";

afterEach(() => vi.unstubAllGlobals());

describe("StormglassClient", () => {
  it("requests tide extremes for the selected control point and preserves station metadata", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      data: [{ height: 1.8, time: "2026-07-13T10:00:00Z", type: "high" }],
      meta: { station: { name: "Кандалакша", distance: 4.2 } },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const client = new StormglassClient("key", 1_000, 0);

    const result = await client.getExtremes({
      id: "pongoma",
      name: "Поньгома",
      shortName: "Поньгома",
      latitude: 65.3446,
      longitude: 34.409,
      order: 15,
      active: true,
    }, new Date("2026-07-13T00:00:00Z"), new Date("2026-07-16T00:00:00Z"));

    expect(result).toEqual([expect.objectContaining({
      pointId: "pongoma",
      type: "high",
      heightM: 1.8,
      stationName: "Кандалакша",
      stationDistanceKm: 4.2,
    })]);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("lat")).toBe("65.3446");
    expect(url.searchParams.get("lng")).toBe("34.409");
    expect(url.searchParams.get("datum")).toBe("MSL");
  });
});
