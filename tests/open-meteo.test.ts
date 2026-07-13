import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPoint } from "../src/domain/types.js";
import { OpenMeteoClient } from "../src/infrastructure/open-meteo.js";

const point: ControlPoint = {
  id: "sea",
  name: "Море",
  shortName: "Море",
  latitude: 66,
  longitude: 33,
  order: 1,
  active: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenMeteoClient", () => {
  it("normalizes visibility and keeps UTC forecast timestamps", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      hourly: {
        time: ["2026-07-11T01:00", "2026-07-11T02:00"],
        temperature_2m: [10, 11],
        precipitation: [0, 0.4],
        precipitation_probability: [10, 70],
        visibility: [12_000, 8_000],
        pressure_msl: [1010, 1009],
        wind_speed_10m: [4, 5],
        wind_direction_10m: [270, 280],
        wind_gusts_10m: [7, 8],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenMeteoClient({ timeoutMs: 1000, retries: 0 });
    const values = await client.getForecast("gfs", point, new Date("2026-07-11T00:30:00Z"), 120);

    expect(values).toHaveLength(2);
    expect(values[0]?.forecastAt.toISOString()).toBe("2026-07-11T01:00:00.000Z");
    expect(values[0]?.visibilityKm).toBe(12);
    expect(values[1]?.precipitationProbabilityPct).toBe(70);
    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.pathname).toBe("/v1/gfs");
    expect(calledUrl.searchParams.get("cell_selection")).toBe("sea");
    expect(calledUrl.searchParams.get("timezone")).toBe("GMT");
    expect(calledUrl.searchParams.get("forecast_hours")).toBe("120");
  });
});
