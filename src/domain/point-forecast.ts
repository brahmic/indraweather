import { windDirectionLabel } from "./bulletin.js";
import { isNearSaturation } from "./analysis.js";
import { summarizeWeatherCodes } from "./weather-condition.js";
import type {
  ControlPoint,
  ForecastValue,
  MarineForecastValue,
} from "./types.js";

export const POINT_FORECAST_DAYS = 5;
export const POINT_FORECAST_HOURS = POINT_FORECAST_DAYS * 24;

export interface PointForecastInput {
  point: ControlPoint;
  generatedAt: Date;
  weather: ForecastValue[];
  marine: MarineForecastValue[];
  timeZone: string;
}

export function renderPointForecast(input: PointForecastInput): string {
  const days = uniqueDays(input.weather, input.timeZone).slice(0, POINT_FORECAST_DAYS);
  if (days.length < POINT_FORECAST_DAYS) {
    throw new Error(`Five-day forecast is incomplete: ${days.length} days available`);
  }

  const lines = [
    `Прогноз на 5 дней · ${input.point.name}`,
    `Обновлено: ${formatDateTime(input.generatedAt, input.timeZone)} МСК`,
    "ECMWF и GFS показаны отдельно: чем дальше срок, тем выше неопределённость.",
  ];
  for (const day of days) {
    const weather = input.weather.filter((value) => localDay(value.forecastAt, input.timeZone) === day);
    const marine = input.marine.filter((value) => localDay(value.forecastAt, input.timeZone) === day);
    const condition = summarizeWeatherCodes(weather.map((value) => value.weatherCode));
    lines.push(
      "",
      `День: ${formatDay(weather[0]?.forecastAt ?? input.generatedAt, input.timeZone)}${condition ? ` · ${condition.icon}` : ""}`,
    );
    const ecmwf = summarizeModel(weather.filter((value) => value.model === "ecmwf"));
    const gfs = summarizeModel(weather.filter((value) => value.model === "gfs"));
    lines.push(`ECMWF: ${ecmwf.text}`);
    lines.push(`GFS: ${gfs.text}`);
    if (ecmwf.maxWindMs !== null && gfs.maxWindMs !== null) {
      lines.push(`Расхождение: максимальный ветер ${formatNumber(Math.abs(ecmwf.maxWindMs - gfs.maxWindMs))} м/с.`);
    }
    const sea = summarizeMarine(marine);
    if (sea) lines.push(`Море: ${sea}.`);
  }
  lines.push("", "Источники: Open-Meteo (ECMWF, NOAA GFS); море: Open-Meteo Marine.");
  return lines.join("\n");
}

function uniqueDays(values: ForecastValue[], timeZone: string): string[] {
  return [...new Set(values.map((value) => localDay(value.forecastAt, timeZone)))].sort();
}

function localDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDay(date: Date, timeZone: string): string {
  const text = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  return text.slice(0, 1).toLocaleUpperCase("ru-RU") + text.slice(1);
}

function summarizeModel(values: ForecastValue[]): { text: string; maxWindMs: number | null } {
  const wind = values.filter((value) => value.windSpeedMs !== null);
  if (wind.length === 0) return { text: "нет данных.", maxWindMs: null };
  const firstDirection = values.find((value) => value.windDirectionDeg !== null)?.windDirectionDeg ?? null;
  const lastDirection = values.findLast((value) => value.windDirectionDeg !== null)?.windDirectionDeg ?? null;
  const minimumTemperature = minimum(values.map((value) => value.temperatureC));
  const maximumTemperature = maximum(values.map((value) => value.temperatureC));
  const minimumApparentTemperature = minimum(values.map((value) => value.apparentTemperatureC));
  const maximumApparentTemperature = maximum(values.map((value) => value.apparentTemperatureC));
  const minimumHumidity = minimum(values.map((value) => value.relativeHumidityPct));
  const maximumHumidity = maximum(values.map((value) => value.relativeHumidityPct));
  const minimumDewPoint = minimum(values.map((value) => value.dewPointC));
  const maximumDewPoint = maximum(values.map((value) => value.dewPointC));
  const parts = [
    `ветер ${formatNumber(minimum(wind.map((value) => value.windSpeedMs)))}–${formatNumber(maximum(wind.map((value) => value.windSpeedMs)))} м/с`,
    formatOptionalMaximum(values.map((value) => value.windGustMs), "порывы до ", " м/с"),
    firstDirection === null || lastDirection === null
      ? null
      : `направление ${windDirectionLabel(firstDirection)} → ${windDirectionLabel(lastDirection)}`,
    `осадки ${formatNumber(sum(values.map((value) => value.precipitationMm)))} мм`,
    minimumTemperature === null || maximumTemperature === null
      ? null
      : `температура ${formatSigned(minimumTemperature)}…${formatSigned(maximumTemperature)} °C`,
    minimumApparentTemperature === null || maximumApparentTemperature === null
      ? null
      : `ощущается как ${formatSigned(minimumApparentTemperature)}…${formatSigned(maximumApparentTemperature)} °C`,
    minimumHumidity === null || maximumHumidity === null
      ? null
      : `влажность ${formatNumber(minimumHumidity)}–${formatNumber(maximumHumidity)}%`,
    minimumDewPoint === null || maximumDewPoint === null
      ? null
      : `точка росы ${formatSigned(minimumDewPoint)}…${formatSigned(maximumDewPoint)} °C`,
    values.some(isNearSaturation) ? "в отдельные часы воздух близок к насыщению" : null,
    formatOptionalMinimum(values.map((value) => value.visibilityKm), "видимость от ", " км"),
  ].filter((value): value is string => value !== null);
  return {
    text: `${parts.join("; ")}.`,
    maxWindMs: maximum(wind.map((value) => value.windSpeedMs)),
  };
}

function summarizeMarine(values: MarineForecastValue[]): string | null {
  const maximumWaveIndex = indexOfMaximum(values.map((value) => value.waveHeightM));
  const maximumWave = maximum(values.map((value) => value.waveHeightM));
  const wavePeriod = maximumWaveIndex === null ? null : values[maximumWaveIndex]?.wavePeriodSeconds ?? null;
  const maximumCurrentIndex = indexOfMaximum(values.map((value) => value.currentSpeedKmh));
  const currentSpeed = maximum(values.map((value) => value.currentSpeedKmh));
  const currentDirection = maximumCurrentIndex === null ? null : values[maximumCurrentIndex]?.currentDirectionDeg ?? null;
  const minimumTemperature = minimum(values.map((value) => value.seaSurfaceTemperatureC));
  const maximumTemperature = maximum(values.map((value) => value.seaSurfaceTemperatureC));
  const parts = [
    maximumWave === null ? null : `волна до ${formatNumber(maximumWave)} м`,
    wavePeriod === null ? null : `период ${formatNumber(wavePeriod)} с`,
    currentSpeed === null
      ? null
      : `течение до ${formatNumber(currentSpeed / 1.852)} уз${currentDirection === null ? "" : `, ${windDirectionLabel(currentDirection)}`}`,
    minimumTemperature === null || maximumTemperature === null
      ? null
      : `вода ${formatSigned(minimumTemperature)}…${formatSigned(maximumTemperature)} °C`,
  ].filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join("; ") : null;
}

function minimum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return present.length === 0 ? null : Math.min(...present);
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return present.length === 0 ? null : Math.max(...present);
}

function indexOfMaximum(values: Array<number | null>): number | null {
  let index: number | null = null;
  for (const [currentIndex, value] of values.entries()) {
    if (value !== null && (index === null || value > (values[index] ?? -Infinity))) index = currentIndex;
  }
  return index;
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function formatOptionalMaximum(values: Array<number | null>, prefix: string, suffix: string): string | null {
  const value = maximum(values);
  return value === null ? null : `${prefix}${formatNumber(value)}${suffix}`;
}

function formatOptionalMinimum(values: Array<number | null>, prefix: string, suffix: string): string | null {
  const value = minimum(values);
  return value === null ? null : `${prefix}${formatNumber(value)}${suffix}`;
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}
