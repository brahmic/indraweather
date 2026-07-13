import sharp from "sharp";
import type { ImageAttachment } from "../delivery/types.js";
import type { MapViewport } from "../domain/map-viewport.js";
import {
  summarizeWeatherCodes,
  weatherConditionForCode,
  weatherConditionGroup,
  type WeatherCondition,
} from "../domain/weather-condition.js";
import type { ForecastMapSnapshot, Database } from "../infrastructure/database.js";
import type { EumetviewClient } from "../infrastructure/eumetview.js";
import type { Logger } from "../logger.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";

export interface ForecastMapOptions {
  bbox: [number, number, number, number];
  width: number;
  height: number;
  maxImageBytes: number;
  timeZone: string;
}

export class ForecastMapService {
  constructor(
    private readonly database: Database,
    private readonly coastlineClient: EumetviewClient,
    private readonly coastlineOverlay: CoastlineOverlayService,
    private readonly options: ForecastMapOptions,
    private readonly logger: Logger,
  ) {}

  async get(runId: string, referenceAt: Date, viewport?: MapViewport): Promise<ImageAttachment> {
    const forecast = await this.database.getForecastMapSnapshot(runId, referenceAt);
    if (!forecast) throw new Error("No forecast data for forecast map");
    const options = viewport
      ? { ...this.options, bbox: viewport.bbox, width: viewport.width, height: viewport.height }
      : this.options;
    const coastlineClient = viewport ? this.coastlineClient.withViewport(viewport) : this.coastlineClient;
    const coastlineOverlay = viewport ? this.coastlineOverlay.withViewport(viewport) : this.coastlineOverlay;

    try {
      const base = await this.createBase(options);
      const coastlined = await coastlineOverlay.apply(base, await coastlineClient.getCoastline());
      const data = await this.addConditions(coastlined, forecast, options);
      return {
        kind: "image",
        data,
        contentType: "image/png",
        filename: `forecast-map-${filenameTime(forecast.forecastAt)}.png`,
        caption: this.caption(forecast.forecastAt),
        source: "Open-Meteo (ECMWF, NOAA GFS); coastline: EUMETView",
        observedAt: forecast.forecastAt,
      };
    } catch (error) {
      this.logger.warn({ err: error, runId }, "Forecast map rendering failed");
      throw error;
    }
  }

  private async createBase(options: ForecastMapOptions): Promise<Uint8Array> {
    const grid = [0.2, 0.4, 0.6, 0.8].flatMap((fraction) => [
      `<path d="M${Math.round(options.width * fraction)} 0V${options.height}" />`,
      `<path d="M0 ${Math.round(options.height * fraction)}H${options.width}" />`,
    ]).join("\n");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}">
      <rect width="100%" height="100%" fill="#527f91"/>
      <g fill="none" stroke="#d5e5ea" stroke-opacity="0.16" stroke-width="1">${grid}</g>
    </svg>`;
    return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
  }

  private async addConditions(
    image: Uint8Array,
    forecast: ForecastMapSnapshot,
    options: ForecastMapOptions,
  ): Promise<Uint8Array> {
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: options.timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(forecast.forecastAt);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}">
      <g>
        <rect x="12" y="12" width="510" height="40" rx="3" fill="#101820" fill-opacity="0.84"/>
        <text x="24" y="29" fill="#ffffff" font-family="Noto Sans, sans-serif" font-size="14" font-weight="700">МОДЕЛЬНАЯ КАРТА · ПРОГНОЗ ${time} МСК</text>
        <text x="24" y="45" fill="#d8e5e9" font-family="Noto Sans, sans-serif" font-size="12">Одна иконка: ECMWF и GFS сходятся · E/G: разные сценарии</text>
      </g>
      ${this.renderConditions(forecast, options)}
    </svg>`;
    const data = await sharp(image).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    if (data.byteLength > options.maxImageBytes) {
      throw new Error(`Forecast map exceeds ${options.maxImageBytes} bytes`);
    }
    return new Uint8Array(data);
  }

  private renderConditions(forecast: ForecastMapSnapshot, options: ForecastMapOptions): string {
    const groups = new Map<string, ForecastMapSnapshot["points"]>();
    for (const point of forecast.points) {
      const current = groups.get(point.pointId) ?? [];
      current.push(point);
      groups.set(point.pointId, current);
    }
    return [...groups.values()].map((models) => this.renderPointConditions(models, options)).join("\n");
  }

  private renderPointConditions(
    models: ForecastMapSnapshot["points"],
    options: ForecastMapOptions,
  ): string {
    const first = models[0];
    if (!first) return "";
    const ecmwf = models.find((model) => model.model === "ecmwf");
    const gfs = models.find((model) => model.model === "gfs");
    const ecmwfCondition = weatherConditionForCode(ecmwf?.weatherCode);
    const gfsCondition = weatherConditionForCode(gfs?.weatherCode);
    const [pointX, pointY] = this.project(first.longitude, first.latitude, options);
    const width = ecmwfCondition && gfsCondition
      && weatherConditionGroup(ecmwfCondition) !== weatherConditionGroup(gfsCondition)
      ? 74
      : 52;
    const x = Math.max(8, Math.min(options.width - width - 8, pointX > options.width * 0.72 ? pointX - width - 12 : pointX + 12));
    const y = Math.max(72, Math.min(options.height - 50, pointY + 14));

    if (ecmwfCondition && gfsCondition
      && weatherConditionGroup(ecmwfCondition) === weatherConditionGroup(gfsCondition)) {
      return conditionMarker(
        x,
        y,
        summarizeWeatherCodes([ecmwf?.weatherCode, gfs?.weatherCode]),
        formatTemperatureRange([ecmwf?.temperatureC, gfs?.temperatureC]),
      );
    }
    if (ecmwfCondition && gfsCondition) {
      return `${conditionMarker(x, y, ecmwfCondition, formatTemperature(ecmwf?.temperatureC), "E")}
        ${conditionMarker(x, y + 20, gfsCondition, formatTemperature(gfs?.temperatureC), "G")}`;
    }
    const model = ecmwf ?? gfs;
    return conditionMarker(
      x,
      y,
      ecmwfCondition ?? gfsCondition,
      formatTemperature(model?.temperatureC),
      ecmwfCondition ? "E" : "G",
    );
  }

  private project(longitude: number, latitude: number, options: ForecastMapOptions): [number, number] {
    const [west, south, east, north] = options.bbox;
    return [
      (longitude - west) / (east - west) * options.width,
      (north - latitude) / (north - south) * options.height,
    ];
  }

  private caption(forecastAt: Date): string {
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.options.timeZone,
      day: "2-digit",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(forecastAt);
    return [
      `Кемь — Кандалакша · модельная карта · прогноз на ${time} МСК`,
      "Одна иконка: ECMWF и GFS дают сходную погоду. E/G: сценарии различаются.",
      "Источники: Open-Meteo (ECMWF, NOAA GFS); береговая основа: EUMETView.",
    ].join("\n");
  }
}

function conditionMarker(
  x: number,
  y: number,
  weather: WeatherCondition | null,
  temperature: string | null,
  label?: "E" | "G",
): string {
  const labelSvg = label
    ? `<text x="${round(x)}" y="${round(y + 5)}" fill="#ffffff" stroke="#17242b" stroke-width="2.5" paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="10" font-weight="800">${label}</text>`
    : "";
  const centerX = x + (label ? 17 : 9);
  const temperatureSvg = temperature
    ? `<text x="${round(x + (label ? 31 : 22))}" y="${round(y + 5)}" fill="#ffffff" stroke="#17242b" stroke-width="3" paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="12" font-weight="800">${temperature}</text>`
    : "";
  return `<g>${labelSvg}${weatherSymbol(weather, centerX, y, 7)}${temperatureSvg}</g>`;
}

function weatherSymbol(weather: WeatherCondition | null, x: number, y: number, size: number): string {
  if (!weather) {
    return `<text x="${round(x)}" y="${round(y + 5)}" text-anchor="middle" fill="#ffffff" stroke="#17242b" stroke-width="3" paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="16" font-weight="700">?</text>`;
  }
  const scale = size / 10;
  const offset = (value: number) => round(value * scale);
  const cloud = `<path d="M${round(x - size)} ${round(y + offset(4))} C${round(x - size)} ${round(y - offset(1))}, ${round(x - offset(5))} ${round(y - offset(4))}, ${round(x - offset(1))} ${round(y - offset(2))} C${round(x + offset(2))} ${round(y - offset(8))}, ${round(x + offset(10))} ${round(y - offset(5))}, ${round(x + offset(10))} ${round(y + offset(1))} C${round(x + offset(15))} ${round(y + offset(1))}, ${round(x + offset(16))} ${round(y + offset(8))}, ${round(x + offset(10))} ${round(y + offset(8))} H${round(x - offset(8))} C${round(x - offset(13))} ${round(y + offset(8))}, ${round(x - offset(14))} ${round(y + offset(4))}, ${round(x - size)} ${round(y + offset(4))} Z" fill="#e7f1f4" stroke="#17242b" stroke-width="${round(1.25 * scale)}"/>`;
  switch (weather.id) {
    case "clear":
      return sunSymbol(x, y, size);
    case "mostly-clear":
    case "partly-cloudy":
      return `${sunSymbol(x - size * 0.45, y - size * 0.45, size * 0.65)}${cloud}`;
    case "overcast":
      return cloud;
    case "fog":
      return `${cloud}<path d="M${round(x - offset(12))} ${round(y + offset(12))}H${round(x + offset(12))} M${round(x - offset(9))} ${round(y + offset(16))}H${round(x + offset(9))}" stroke="#d8e5e9" stroke-width="${round(2 * scale)}" stroke-linecap="round"/>`;
    case "drizzle":
    case "freezing-drizzle":
      return `${cloud}<path d="M${round(x - offset(6))} ${round(y + offset(12))}l${-offset(2)} ${offset(4)} M${round(x)} ${round(y + offset(12))}l${-offset(2)} ${offset(4)} M${round(x + offset(6))} ${round(y + offset(12))}l${-offset(2)} ${offset(4)}" stroke="#5bc0de" stroke-width="${round(2 * scale)}" stroke-linecap="round"/>`;
    case "rain":
    case "freezing-rain":
    case "showers":
      return `${cloud}<path d="M${round(x - offset(7))} ${round(y + offset(12))}l${-offset(2)} ${offset(5)} M${round(x)} ${round(y + offset(12))}l${-offset(2)} ${offset(5)} M${round(x + offset(7))} ${round(y + offset(12))}l${-offset(2)} ${offset(5)}" stroke="#29b6f6" stroke-width="${round(2.5 * scale)}" stroke-linecap="round"/>`;
    case "snow":
    case "snow-showers":
      return `${cloud}<g stroke="#ffffff" stroke-width="${round(1.6 * scale)}" stroke-linecap="round"><path d="M${round(x - offset(5))} ${round(y + offset(12))}v${offset(6)} M${round(x - offset(8))} ${round(y + offset(15))}h${offset(6)} M${round(x + offset(5))} ${round(y + offset(12))}v${offset(6)} M${round(x + offset(2))} ${round(y + offset(15))}h${offset(6)}"/></g>`;
    case "thunderstorm":
      return `${cloud}<path d="M${round(x + offset(1))} ${round(y + offset(9))}l${-offset(5)} ${offset(9)}h${offset(5)}l${-offset(2)} ${offset(7)} ${offset(8)} ${-offset(11)}h${-offset(5)}l${offset(3)} ${-offset(5)}Z" fill="#ffd54f" stroke="#17242b" stroke-width="${round(scale)}"/>`;
    default:
      return "";
  }
}

function formatTemperature(temperature: number | null | undefined): string | null {
  if (temperature === null || temperature === undefined || !Number.isFinite(temperature)) return null;
  const rounded = Math.round(temperature);
  return `${rounded > 0 ? "+" : ""}${rounded}°`;
}

function formatTemperatureRange(temperatures: Array<number | null | undefined>): string | null {
  const values = temperatures.filter((temperature): temperature is number =>
    temperature !== null && temperature !== undefined && Number.isFinite(temperature),
  ).map(Math.round);
  if (values.length === 0) return null;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) return formatTemperature(minimum);
  const maximumText = `${maximum > 0 ? "" : maximum < 0 ? "-" : ""}${Math.abs(maximum)}°`;
  return `${formatTemperature(minimum)}…${maximumText}`;
}

function sunSymbol(x: number, y: number, size: number): string {
  return `<g fill="none" stroke="#ffd54f" stroke-width="2" stroke-linecap="round">
    <circle cx="${round(x)}" cy="${round(y)}" r="${round(size * 0.45)}" fill="#ffd54f" stroke="#17242b" stroke-width="1"/>
    <path d="M${round(x)} ${round(y - size)}V${round(y - size * 0.7)} M${round(x)} ${round(y + size * 0.7)}V${round(y + size)} M${round(x - size)} ${round(y)}H${round(x - size * 0.7)} M${round(x + size * 0.7)} ${round(y)}H${round(x + size)} M${round(x - size * 0.72)} ${round(y - size * 0.72)}L${round(x - size * 0.5)} ${round(y - size * 0.5)} M${round(x + size * 0.5)} ${round(y + size * 0.5)}L${round(x + size * 0.72)} ${round(y + size * 0.72)} M${round(x + size * 0.72)} ${round(y - size * 0.72)}L${round(x + size * 0.5)} ${round(y - size * 0.5)} M${round(x - size * 0.5)} ${round(y + size * 0.5)}L${round(x - size * 0.72)} ${round(y + size * 0.72)}"/>
  </g>`;
}

function filenameTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
