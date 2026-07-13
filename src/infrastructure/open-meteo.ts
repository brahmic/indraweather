import { z } from "zod";
import type { ControlPoint, ForecastValue, WeatherModel } from "../domain/types.js";
import { fetchJson } from "./http.js";

const nullableNumbers = z.array(z.number().nullable());
const responseSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: nullableNumbers,
    precipitation: nullableNumbers,
    precipitation_probability: nullableNumbers.optional(),
    weather_code: nullableNumbers,
    visibility: nullableNumbers,
    pressure_msl: nullableNumbers,
    wind_speed_10m: nullableNumbers,
    wind_direction_10m: nullableNumbers,
    wind_gusts_10m: nullableNumbers,
  }),
});

const endpoints: Record<WeatherModel, string> = {
  ecmwf: "https://api.open-meteo.com/v1/ecmwf",
  gfs: "https://api.open-meteo.com/v1/gfs",
};

export interface OpenMeteoOptions {
  timeoutMs: number;
  retries: number;
}

export class OpenMeteoClient {
  constructor(private readonly options: OpenMeteoOptions) {}

  async getForecast(
    model: WeatherModel,
    point: ControlPoint,
    now = new Date(),
    horizonHours = 48,
  ): Promise<ForecastValue[]> {
    const url = new URL(endpoints[model]);
    url.searchParams.set("latitude", String(point.latitude));
    url.searchParams.set("longitude", String(point.longitude));
    const variables = [
      "temperature_2m",
      "precipitation",
      "weather_code",
      "visibility",
      "pressure_msl",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
    ];
    if (model === "gfs") variables.push("precipitation_probability");
    url.searchParams.set("hourly", variables.join(","));
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("precipitation_unit", "mm");
    url.searchParams.set("timezone", "GMT");
    url.searchParams.set("forecast_hours", String(horizonHours));
    url.searchParams.set("cell_selection", "sea");

    const raw = await fetchJson(url, this.options);
    const { hourly } = responseSchema.parse(raw);
    const receivedAt = new Date();
    const horizonEnd = new Date(now.getTime() + horizonHours * 60 * 60 * 1000);

    return hourly.time.flatMap((time, index) => {
      const forecastAt = new Date(`${time}Z`);
      if (Number.isNaN(forecastAt.getTime()) || forecastAt < now || forecastAt > horizonEnd) {
        return [];
      }
      return [{
        pointId: point.id,
        model,
        forecastAt,
        receivedAt,
        windSpeedMs: at(hourly.wind_speed_10m, index),
        windGustMs: at(hourly.wind_gusts_10m, index),
        windDirectionDeg: at(hourly.wind_direction_10m, index),
        precipitationMm: at(hourly.precipitation, index),
        precipitationProbabilityPct: at(hourly.precipitation_probability, index),
        weatherCode: at(hourly.weather_code, index),
        visibilityKm: divide(at(hourly.visibility, index), 1000),
        pressureHpa: at(hourly.pressure_msl, index),
        temperatureC: at(hourly.temperature_2m, index),
      }];
    });
  }
}

function at(values: Array<number | null> | undefined, index: number): number | null {
  return values?.[index] ?? null;
}

function divide(value: number | null, divisor: number): number | null {
  return value === null ? null : value / divisor;
}
