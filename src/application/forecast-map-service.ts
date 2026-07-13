import sharp from "sharp";
import type { ImageAttachment } from "../delivery/types.js";
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
import type { WindOverlayService } from "./wind-overlay-service.js";

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
    private readonly windOverlay: WindOverlayService,
    private readonly options: ForecastMapOptions,
    private readonly logger: Logger,
  ) {}

  async get(runId: string, referenceAt: Date): Promise<ImageAttachment> {
    const forecast = await this.database.getForecastMapSnapshot(runId, referenceAt);
    if (!forecast) throw new Error("No forecast data for forecast map");

    try {
      const base = await this.createBase();
      const coastlined = await this.coastlineOverlay.apply(base, await this.coastlineClient.getCoastline());
      const withWind = await this.windOverlay.applyForecast(coastlined, forecast, { headerTop: 64 });
      const data = await this.addConditions(withWind, forecast);
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

  private async createBase(): Promise<Uint8Array> {
    const grid = [0.2, 0.4, 0.6, 0.8].flatMap((fraction) => [
      `<path d="M${Math.round(this.options.width * fraction)} 0V${this.options.height}" />`,
      `<path d="M0 ${Math.round(this.options.height * fraction)}H${this.options.width}" />`,
    ]).join("\n");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.options.width}" height="${this.options.height}">
      <rect width="100%" height="100%" fill="#527f91"/>
      <g fill="none" stroke="#d5e5ea" stroke-opacity="0.16" stroke-width="1">${grid}</g>
    </svg>`;
    return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
  }

  private async addConditions(image: Uint8Array, forecast: ForecastMapSnapshot): Promise<Uint8Array> {
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.options.timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(forecast.forecastAt);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.options.width}" height="${this.options.height}">
      <g>
        <rect x="12" y="12" width="510" height="40" rx="3" fill="#101820" fill-opacity="0.84"/>
        <text x="24" y="29" fill="#ffffff" font-family="Noto Sans, sans-serif" font-size="14" font-weight="700">МОДЕЛЬНАЯ КАРТА · ПРОГНОЗ ${time} МСК</text>
        <text x="24" y="45" fill="#d8e5e9" font-family="Noto Sans, sans-serif" font-size="12">Одна иконка: ECMWF и GFS сходятся · E/G: разные сценарии</text>
      </g>
      ${this.renderConditions(forecast)}
    </svg>`;
    const data = await sharp(image).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    if (data.byteLength > this.options.maxImageBytes) {
      throw new Error(`Forecast map exceeds ${this.options.maxImageBytes} bytes`);
    }
    return new Uint8Array(data);
  }

  private renderConditions(forecast: ForecastMapSnapshot): string {
    const groups = new Map<string, ForecastMapSnapshot["points"]>();
    for (const point of forecast.points) {
      const current = groups.get(point.pointId) ?? [];
      current.push(point);
      groups.set(point.pointId, current);
    }
    return [...groups.values()].map((models) => this.renderPointConditions(models)).join("\n");
  }

  private renderPointConditions(models: ForecastMapSnapshot["points"]): string {
    const first = models[0];
    if (!first) return "";
    const ecmwf = models.find((model) => model.model === "ecmwf");
    const gfs = models.find((model) => model.model === "gfs");
    const ecmwfCondition = weatherConditionForCode(ecmwf?.weatherCode);
    const gfsCondition = weatherConditionForCode(gfs?.weatherCode);
    const [pointX, pointY] = this.project(first.longitude, first.latitude);
    const width = ecmwfCondition && gfsCondition
      && weatherConditionGroup(ecmwfCondition) !== weatherConditionGroup(gfsCondition)
      ? 88
      : 45;
    const x = Math.max(8, Math.min(this.options.width - width - 8, pointX > this.options.width * 0.72 ? pointX - width - 12 : pointX + 12));
    const y = Math.max(122, Math.min(this.options.height - 44, pointY + 14));

    if (ecmwfCondition && gfsCondition
      && weatherConditionGroup(ecmwfCondition) === weatherConditionGroup(gfsCondition)) {
      return conditionCard(x, y, width, summarizeWeatherCodes([ecmwf?.weatherCode, gfs?.weatherCode]));
    }
    if (ecmwfCondition && gfsCondition) {
      return `${conditionCard(x, y, width, ecmwfCondition, "E", 27)}
        ${conditionCard(x + 44, y, 44, gfsCondition, "G", 27, false)}`;
    }
    return conditionCard(x, y, width, ecmwfCondition ?? gfsCondition, ecmwfCondition ? "E" : "G", 28);
  }

  private project(longitude: number, latitude: number): [number, number] {
    const [west, south, east, north] = this.options.bbox;
    return [
      (longitude - west) / (east - west) * this.options.width,
      (north - latitude) / (north - south) * this.options.height,
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

function conditionCard(
  x: number,
  y: number,
  width: number,
  weather: WeatherCondition | null,
  label?: "E" | "G",
  iconOffset = 0,
  includeBackground = true,
): string {
  const background = includeBackground
    ? `<rect x="${round(x)}" y="${round(y)}" width="${width}" height="34" rx="3" fill="#101820" fill-opacity="0.82"/>`
    : "";
  const labelSvg = label
    ? `<text x="${round(x + 6)}" y="${round(y + 21)}" fill="#d8e5e9" font-family="Noto Sans, sans-serif" font-size="11" font-weight="700">${label}</text>`
    : "";
  const centerX = x + (label ? iconOffset : width / 2);
  return `<g>${background}${labelSvg}${weatherSymbol(weather, centerX, y + 17, 10)}</g>`;
}

function weatherSymbol(weather: WeatherCondition | null, x: number, y: number, size: number): string {
  if (!weather) {
    return `<text x="${round(x)}" y="${round(y + 5)}" text-anchor="middle" fill="#ffffff" font-family="Noto Sans, sans-serif" font-size="18" font-weight="700">?</text>`;
  }
  const cloud = `<path d="M${round(x - size)} ${round(y + 4)} C${round(x - size)} ${round(y - 1)}, ${round(x - 5)} ${round(y - 4)}, ${round(x - 1)} ${round(y - 2)} C${round(x + 2)} ${round(y - 8)}, ${round(x + 10)} ${round(y - 5)}, ${round(x + 10)} ${round(y + 1)} C${round(x + 15)} ${round(y + 1)}, ${round(x + 16)} ${round(y + 8)}, ${round(x + 10)} ${round(y + 8)} H${round(x - 8)} C${round(x - 13)} ${round(y + 8)}, ${round(x - 14)} ${round(y + 4)}, ${round(x - 10)} ${round(y + 4)} Z" fill="#e7f1f4" stroke="#17242b" stroke-width="1.25"/>`;
  switch (weather.id) {
    case "clear":
      return sunSymbol(x, y, size);
    case "mostly-clear":
    case "partly-cloudy":
      return `${sunSymbol(x - size * 0.45, y - size * 0.45, size * 0.65)}${cloud}`;
    case "overcast":
      return cloud;
    case "fog":
      return `${cloud}<path d="M${round(x - 12)} ${round(y + 12)}H${round(x + 12)} M${round(x - 9)} ${round(y + 16)}H${round(x + 9)}" stroke="#d8e5e9" stroke-width="2" stroke-linecap="round"/>`;
    case "drizzle":
    case "freezing-drizzle":
      return `${cloud}<path d="M${round(x - 6)} ${round(y + 12)}l-2 4 M${round(x)} ${round(y + 12)}l-2 4 M${round(x + 6)} ${round(y + 12)}l-2 4" stroke="#5bc0de" stroke-width="2" stroke-linecap="round"/>`;
    case "rain":
    case "freezing-rain":
    case "showers":
      return `${cloud}<path d="M${round(x - 7)} ${round(y + 12)}l-2 5 M${round(x)} ${round(y + 12)}l-2 5 M${round(x + 7)} ${round(y + 12)}l-2 5" stroke="#29b6f6" stroke-width="2.5" stroke-linecap="round"/>`;
    case "snow":
    case "snow-showers":
      return `${cloud}<g stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"><path d="M${round(x - 5)} ${round(y + 12)}v6 M${round(x - 8)} ${round(y + 15)}h6 M${round(x + 5)} ${round(y + 12)}v6 M${round(x + 2)} ${round(y + 15)}h6"/></g>`;
    case "thunderstorm":
      return `${cloud}<path d="M${round(x + 1)} ${round(y + 9)}l-5 9h5l-2 7 8-11h-5l3-5Z" fill="#ffd54f" stroke="#17242b" stroke-width="1"/>`;
    default:
      return "";
  }
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
