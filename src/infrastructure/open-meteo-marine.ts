import { z } from "zod";
import type {
  ControlPoint,
  MarineForecastValue,
  MarinePointSummary,
} from "../domain/types.js";
import { fetchJson } from "./http.js";

const values = z.array(z.number().nullable());
const responseSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
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

  async getForecast(
    point: ControlPoint,
    now = new Date(),
    horizonHours = 24,
  ): Promise<MarineForecastValue[]> {
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
    url.searchParams.set("forecast_hours", String(horizonHours));
    url.searchParams.set("timezone", "GMT");
    url.searchParams.set("cell_selection", "sea");
    const hourly = responseSchema.parse(await fetchJson(url, this.options)).hourly;
    const horizonEnd = new Date(now.getTime() + horizonHours * 60 * 60 * 1000);
    return hourly.time.flatMap((time, index): MarineForecastValue[] => {
      const forecastAt = new Date(`${time}Z`);
      if (Number.isNaN(forecastAt.getTime()) || forecastAt < now || forecastAt > horizonEnd) return [];
      return [{
        pointId: point.id,
        forecastAt,
        waveHeightM: at(hourly.wave_height, index),
        waveDirectionDeg: at(hourly.wave_direction, index),
        wavePeriodSeconds: at(hourly.wave_period, index),
        windWaveHeightM: at(hourly.wind_wave_height, index),
        swellHeightM: at(hourly.swell_wave_height, index),
        currentSpeedKmh: at(hourly.ocean_current_velocity, index),
        currentDirectionDeg: at(hourly.ocean_current_direction, index),
        seaSurfaceTemperatureC: at(hourly.sea_surface_temperature, index),
      }];
    });
  }

  async getSummary(point: ControlPoint, now = new Date()): Promise<MarinePointSummary> {
    return summarizeMarine(point, await this.getForecast(point, now));
  }
}

export function summarizeMarine(
  point: ControlPoint,
  values: MarineForecastValue[],
): MarinePointSummary {
  const waveHeights = values.map((value) => value.waveHeightM);
  const currentSpeeds = values.map((value) => value.currentSpeedKmh);
  const maximumWaveIndex = indexOfMaximum(waveHeights);
  const maximumCurrentIndex = indexOfMaximum(currentSpeeds);
  return {
    point,
    minWaveHeightM: minimum(waveHeights),
    maxWaveHeightM: maximum(waveHeights),
    waveDirectionDeg: at(values.map((value) => value.waveDirectionDeg), maximumWaveIndex),
    minWavePeriodSeconds: minimum(values.map((value) => value.wavePeriodSeconds)),
    maxWavePeriodSeconds: maximum(values.map((value) => value.wavePeriodSeconds)),
    maxWindWaveHeightM: maximum(values.map((value) => value.windWaveHeightM)),
    maxSwellHeightM: maximum(values.map((value) => value.swellHeightM)),
    maxCurrentKnots: kilometresPerHourToKnots(maximum(currentSpeeds)),
    currentDirectionDeg: at(values.map((value) => value.currentDirectionDeg), maximumCurrentIndex),
    seaSurfaceTemperatureC: first(values.map((value) => value.seaSurfaceTemperatureC)),
  };
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
