import { z } from "zod";
import type { ControlPoint, MarinePointSummary } from "../domain/types.js";
import { fetchJson } from "./http.js";

const values = z.array(z.number().nullable());
const responseSchema = z.object({
  hourly: z.object({
    wave_height: values,
    wave_direction: values,
    wave_period: values,
    wind_wave_height: values,
    swell_wave_height: values,
    ocean_current_velocity: values,
    ocean_current_direction: values,
    sea_surface_temperature: values,
  }),
});

export interface OpenMeteoMarineOptions {
  timeoutMs: number;
  retries: number;
}

export class OpenMeteoMarineClient {
  constructor(private readonly options: OpenMeteoMarineOptions) {}

  async getSummary(point: ControlPoint): Promise<MarinePointSummary> {
    const url = new URL("https://marine-api.open-meteo.com/v1/marine");
    url.searchParams.set("latitude", String(point.latitude));
    url.searchParams.set("longitude", String(point.longitude));
    url.searchParams.set("hourly", [
      "wave_height",
      "wave_direction",
      "wave_period",
      "wind_wave_height",
      "swell_wave_height",
      "ocean_current_velocity",
      "ocean_current_direction",
      "sea_surface_temperature",
    ].join(","));
    url.searchParams.set("forecast_hours", "24");
    url.searchParams.set("timezone", "GMT");
    url.searchParams.set("cell_selection", "sea");
    const hourly = responseSchema.parse(await fetchJson(url, this.options)).hourly;
    const maximumWaveIndex = indexOfMaximum(hourly.wave_height);
    const maximumCurrentIndex = indexOfMaximum(hourly.ocean_current_velocity);
    return {
      point,
      minWaveHeightM: minimum(hourly.wave_height),
      maxWaveHeightM: maximum(hourly.wave_height),
      waveDirectionDeg: at(hourly.wave_direction, maximumWaveIndex),
      minWavePeriodSeconds: minimum(hourly.wave_period),
      maxWavePeriodSeconds: maximum(hourly.wave_period),
      maxWindWaveHeightM: maximum(hourly.wind_wave_height),
      maxSwellHeightM: maximum(hourly.swell_wave_height),
      maxCurrentKnots: kilometresPerHourToKnots(maximum(hourly.ocean_current_velocity)),
      currentDirectionDeg: at(hourly.ocean_current_direction, maximumCurrentIndex),
      seaSurfaceTemperatureC: first(hourly.sea_surface_temperature),
    };
  }
}

function at(values: Array<number | null>, index: number | null): number | null {
  return index === null ? null : values[index] ?? null;
}

function first(values: Array<number | null>): number | null {
  return values.find((value): value is number => value !== null) ?? null;
}

function minimum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.min(...present) : null;
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function indexOfMaximum(values: Array<number | null>): number | null {
  let index: number | null = null;
  for (const [currentIndex, value] of values.entries()) {
    if (value !== null && (index === null || value > (values[index] ?? -Infinity))) index = currentIndex;
  }
  return index;
}

function kilometresPerHourToKnots(value: number | null): number | null {
  return value === null ? null : value / 1.852;
}
