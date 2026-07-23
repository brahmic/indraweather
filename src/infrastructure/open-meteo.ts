import { z } from "zod";
import type { ControlPoint, ForecastValue, WeatherModel } from "../domain/types.js";
import { fetchJson } from "./http.js";

const nullableNumbers = z.array(z.number().nullable());
const responseSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: nullableNumbers,
    relative_humidity_2m: nullableNumbers,
    dew_point_2m: nullableNumbers,
    apparent_temperature: nullableNumbers,
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

  async getForecasts(
    model: WeatherModel,
    points: ControlPoint[],
    now = new Date(),
    horizonHours = 48,
  ): Promise<ForecastValue[]> {
    if (points.length === 0) return [];
    const url = forecastUrl(model, points, horizonHours);
    const raw = await fetchJson(url, this.options);
    const responses = Array.isArray(raw) ? raw : [raw];
    if (responses.length !== points.length) {
      throw new Error(`Expected ${points.length} locations, received ${responses.length}`);
    }
    return responses.flatMap((response, index) => {
      const point = points[index];
      if (!point) return [];
      return parseForecast(response, model, point, now, horizonHours);
    });
  }

  async getForecast(
    model: WeatherModel,
    point: ControlPoint,
    now = new Date(),
    horizonHours = 48,
  ): Promise<ForecastValue[]> {
    return this.getForecasts(model, [point], now, horizonHours);
  }
}

function forecastUrl(model: WeatherModel, points: ControlPoint[], horizonHours: number): URL {
  const url = new URL(endpoints[model]);
  url.searchParams.set("latitude", points.map((point) => point.latitude).join(","));
  url.searchParams.set("longitude", points.map((point) => point.longitude).join(","));
  const variables = [
    "temperature_2m",
    "relative_humidity_2m",
    "dew_point_2m",
    "apparent_temperature",
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
  return url;
}

function parseForecast(
  raw: unknown,
  model: WeatherModel,
  point: ControlPoint,
  now: Date,
  horizonHours: number,
): ForecastValue[] {
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
      relativeHumidityPct: at(hourly.relative_humidity_2m, index),
      dewPointC: at(hourly.dew_point_2m, index),
      apparentTemperatureC: at(hourly.apparent_temperature, index),
    }];
  });
}

function at(values: Array<number | null> | undefined, index: number): number | null {
  return values?.[index] ?? null;
}

function divide(value: number | null, divisor: number): number | null {
  return value === null ? null : value / divisor;
}
