import sharp from "sharp";
import { circularDifference } from "../domain/analysis.js";
import type { MapViewport } from "../domain/map-viewport.js";
import type { Database, WindOverlayForecast } from "../infrastructure/database.js";
import type { Logger } from "../logger.js";

export interface WindOverlayOptions {
  bbox: [number, number, number, number];
  width: number;
  height: number;
  maxImageBytes: number;
  directionAgreementDeg: number;
  timeZone: string;
}

export interface WindOverlayPlacement {
  headerTop?: number;
}

export class WindOverlayService {
  constructor(
    private readonly database: Database,
    private readonly options: WindOverlayOptions,
    private readonly logger: Logger,
  ) {}

  withViewport(viewport: MapViewport): WindOverlayService {
    return new WindOverlayService(this.database, {
      ...this.options,
      bbox: viewport.bbox,
      width: viewport.width,
      height: viewport.height,
    }, this.logger);
  }

  async apply(
    image: Uint8Array,
    referenceAt: Date,
    placement: WindOverlayPlacement = {},
  ): Promise<Uint8Array> {
    let forecast: WindOverlayForecast | null;
    try {
      forecast = await this.database.getLatestWindOverlay(referenceAt);
    } catch (error) {
      this.logger.warn({ err: error }, "Wind overlay data is unavailable");
      return image;
    }
    if (!forecast) return image;

    try {
      const result = await sharp(image)
        .composite([{ input: Buffer.from(this.render(forecast, placement.headerTop ?? 12)) }])
        .png()
        .toBuffer();
      if (result.byteLength > this.options.maxImageBytes) {
        throw new Error(`Image with wind overlay exceeds ${this.options.maxImageBytes} bytes`);
      }
      return new Uint8Array(result);
    } catch (error) {
      this.logger.warn({ err: error }, "Wind overlay rendering failed");
      return image;
    }
  }

  private render(forecast: WindOverlayForecast, headerTop: number): string {
    const groups = new Map<string, typeof forecast.points>();
    for (const point of forecast.points) {
      const current = groups.get(point.pointId) ?? [];
      current.push(point);
      groups.set(point.pointId, current);
    }
    const arrows = [...groups.values()].flatMap((models) => this.renderPoint(models));
    if (arrows.length === 0) return emptySvg(this.options.width, this.options.height);
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.options.timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(forecast.forecastAt);
    const hasDifference = arrows.some((arrow) => arrow.kind === "model");
    const header = `ВЕТЕР · ПРОГНОЗ ${time} МСК`;
    const legend = hasDifference ? "E ECMWF   G GFS" : "ECMWF/GFS";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.options.width}" height="${this.options.height}">
      <g>
        <rect x="12" y="${headerTop}" width="236" height="45" rx="3" fill="#101820" fill-opacity="0.82"/>
        <text x="24" y="${headerTop + 19}" fill="#ffffff" font-family="Noto Sans, sans-serif" font-size="14" font-weight="700">${header}</text>
        <text x="24" y="${headerTop + 36}" fill="#cfd8dc" font-family="Noto Sans, sans-serif" font-size="12">${legend}</text>
      </g>
      ${arrows.map((arrow) => arrow.svg).join("\n")}
    </svg>`;
  }

  private renderPoint(models: WindOverlayForecast["points"]): RenderedArrow[] {
    const valid = models.filter((model) =>
      model.speedMs !== null && model.directionDeg !== null && Number.isFinite(model.speedMs) && Number.isFinite(model.directionDeg));
    if (valid.length === 0) return [];
    const first = valid[0];
    if (!first) return [];
    const [x, y] = this.project(first.longitude, first.latitude);
    const ecmwf = valid.find((model) => model.model === "ecmwf");
    const gfs = valid.find((model) => model.model === "gfs");
    if (ecmwf && gfs && ecmwf.directionDeg !== null && gfs.directionDeg !== null
      && circularDifference(ecmwf.directionDeg, gfs.directionDeg) <= this.options.directionAgreementDeg) {
      const direction = meanDirection(ecmwf.directionDeg, gfs.directionDeg);
      const minimum = Math.min(ecmwf.speedMs ?? 0, gfs.speedMs ?? 0);
      const maximum = Math.max(ecmwf.speedMs ?? 0, gfs.speedMs ?? 0);
      return [{
        kind: "agreed",
        svg: arrowSvg(x, y, direction, maximum, "#4dd0e1", `${speedRange(minimum, maximum)}`),
      }];
    }
    return valid.map((model) => ({
      kind: "model" as const,
      svg: arrowSvg(
        x,
        y,
        model.directionDeg ?? 0,
        model.speedMs ?? 0,
        model.model === "ecmwf" ? "#42a5f5" : "#ffb74d",
        `${model.model === "ecmwf" ? "E" : "G"} ${round(model.speedMs ?? 0)}`,
      ),
    }));
  }

  private project(longitude: number, latitude: number): [number, number] {
    const [west, south, east, north] = this.options.bbox;
    return [
      (longitude - west) / (east - west) * this.options.width,
      (north - latitude) / (north - south) * this.options.height,
    ];
  }
}

interface RenderedArrow {
  kind: "agreed" | "model";
  svg: string;
}

function arrowSvg(
  x: number,
  y: number,
  directionFromDeg: number,
  speedMs: number,
  color: string,
  label: string,
): string {
  const heading = (directionFromDeg + 180) * Math.PI / 180;
  const length = 22 + Math.min(20, Math.max(0, speedMs)) * 1.4;
  const dx = Math.sin(heading);
  const dy = -Math.cos(heading);
  const endX = x + dx * length;
  const endY = y + dy * length;
  const sideX = -dy;
  const sideY = dx;
  const headBaseX = endX - dx * 9;
  const headBaseY = endY - dy * 9;
  const leftX = headBaseX + sideX * 5;
  const leftY = headBaseY + sideY * 5;
  const rightX = headBaseX - sideX * 5;
  const rightY = headBaseY - sideY * 5;
  const textAnchor = dx >= 0 ? "start" : "end";
  const textX = endX + (dx >= 0 ? 7 : -7);
  const textY = endY + (dy >= 0 ? 14 : -7);
  return `<g>
    <path d="M${round(x)} ${round(y)} L${round(endX)} ${round(endY)}" fill="none" stroke="#17242b" stroke-width="5" stroke-linecap="round" opacity="0.9"/>
    <path d="M${round(x)} ${round(y)} L${round(endX)} ${round(endY)}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
    <path d="M${round(endX)} ${round(endY)} L${round(leftX)} ${round(leftY)} L${round(rightX)} ${round(rightY)} Z" fill="${color}" stroke="#17242b" stroke-width="1"/>
    <text x="${round(textX)}" y="${round(textY)}" text-anchor="${textAnchor}" fill="#ffffff" stroke="#17242b" stroke-width="3" paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="14" font-weight="700">${label}</text>
  </g>`;
}

function meanDirection(left: number, right: number): number {
  const leftRadians = left * Math.PI / 180;
  const rightRadians = right * Math.PI / 180;
  return Math.atan2(
    Math.sin(leftRadians) + Math.sin(rightRadians),
    Math.cos(leftRadians) + Math.cos(rightRadians),
  ) * 180 / Math.PI;
}

function speedRange(minimum: number, maximum: number): string {
  return minimum === maximum ? `${round(minimum)}` : `${round(minimum)}–${round(maximum)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function emptySvg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`;
}
