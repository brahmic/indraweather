import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenMeteoMarineClient } from "../src/infrastructure/open-meteo-marine.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenMeteoMarineClient", () => {
  it("summarises waves, current, and sea surface temperature for one point", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      hourly: {
        time: ["2026-07-11T01:00", "2026-07-11T02:00", "2026-07-11T03:00"],
        wave_height: [0.2, 0.7, 0.4],
        wave_direction: [90, 120, 140],
        wave_period: [2, 4, 3],
        wind_wave_height: [0.1, 0.5, 0.2],
        swell_wave_height: [0.1, 0.3, 0.2],
        ocean_current_velocity: [0.2, 0.6, 0.4],
        ocean_current_direction: [0, 45, 90],
        sea_surface_temperature: [8.4, 8.3, 8.2],
      },
    }), { headers: { "content-type": "application/json" } })));
    const client = new OpenMeteoMarineClient({ timeoutMs: 1000, retries: 0 });

    const result = await client.getSummary({
      id: "kem", name: "Кемь", shortName: "Кемь", latitude: 65, longitude: 34, order: 1, active: true,
    }, new Date("2026-07-11T00:30:00Z"));

    expect(result).toMatchObject({
      minWaveHeightM: 0.2,
      maxWaveHeightM: 0.7,
      waveDirectionDeg: 120,
      minWavePeriodSeconds: 2,
      maxWavePeriodSeconds: 4,
      maxWindWaveHeightM: 0.5,
      maxSwellHeightM: 0.3,
      currentDirectionDeg: 45,
      seaSurfaceTemperatureC: 8.4,
    });
    expect(result.maxCurrentKnots).toBeCloseTo(0.6 / 1.852);
  });
});
