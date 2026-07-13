import sharp from "sharp";
import type { ImageAttachment } from "../delivery/types.js";
import type { MapViewport } from "../domain/map-viewport.js";
import type { ControlPoint } from "../domain/types.js";
import type { EumetsatLightningClient, LightningFlash } from "../infrastructure/eumetsat-lightning.js";
import type { EumetviewClient } from "../infrastructure/eumetview.js";
import type { Logger } from "../logger.js";
import { BoundedTtlCache } from "./bounded-ttl-cache.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";
import type { SatelliteImageService } from "./satellite-image-service.js";

export interface LightningServiceOptions {
  bbox: [number, number, number, number];
  width: number;
  height: number;
  maxImageBytes: number;
  windowMinutes: number;
  cacheMinutes: number;
  cacheMaxEntries: number;
  timeZone: string;
}

interface CachedLightning {
  flashes: LightningFlash[];
  fetchedAt: Date;
}

interface LightningBackground {
  data: Uint8Array;
  satelliteObservedAt: Date | null;
}

export class LightningService {
  private readonly cached: BoundedTtlCache<CachedLightning>;

  constructor(
    private readonly client: EumetsatLightningClient,
    private readonly coastline: CoastlineOverlayService,
    private readonly coastlineSource: EumetviewClient,
    private readonly points: readonly ControlPoint[],
    private readonly options: LightningServiceOptions,
    private readonly satellite: SatelliteImageService | null = null,
    private readonly logger: Pick<Logger, "warn"> = { warn: () => undefined },
  ) {
    this.cached = new BoundedTtlCache(
      options.cacheMinutes * 60_000,
      options.cacheMaxEntries,
    );
  }

  async getLatest(viewport?: MapViewport): Promise<ImageAttachment> {
    const options = viewport
      ? { ...this.options, bbox: viewport.bbox, width: viewport.width, height: viewport.height }
      : this.options;
    const now = new Date();
    const start = new Date(now.getTime() - options.windowMinutes * 60_000);
    const key = `lightning:${viewportKey(viewport)}`;
    const [cached, background] = await Promise.all([
      this.cached.getOrLoad(key, now, async () => ({
        flashes: await this.client.getFlashes(start, now, options.bbox),
        fetchedAt: new Date(),
      })),
      this.getBackground(now, viewport, options),
    ]);
    const data = await this.addFlashes(
      background.data,
      cached.flashes,
      cached.fetchedAt,
      options,
      background.satelliteObservedAt,
    );
    return {
      kind: "image",
      data,
      contentType: "image/png",
      filename: `lightning-${filenameTime(cached.fetchedAt)}.png`,
      caption: this.caption(cached.flashes, cached.fetchedAt, options, background.satelliteObservedAt),
      source: background.satelliteObservedAt
        ? "EUMETSAT MTG Lightning Imager (LI); satellite background: EUMETView"
        : "EUMETSAT MTG Lightning Imager (LI), LI Lightning Flashes",
      observedAt: cached.fetchedAt,
    };
  }

  private async getBackground(
    now: Date,
    viewport: MapViewport | undefined,
    options: LightningServiceOptions,
  ): Promise<LightningBackground> {
    if (this.satellite) {
      try {
        const image = await this.satellite.getLatest(now, viewport);
        return {
          data: await this.dimSatellite(image.data, options),
          satelliteObservedAt: image.observedAt,
        };
      } catch (error) {
        this.logger.warn({ err: error }, "Lightning satellite background unavailable; using cartographic fallback");
      }
    }

    const base = await this.createBase(options);
    const coastline = viewport ? this.coastline.withViewport(viewport) : this.coastline;
    const coastlineSource = viewport ? this.coastlineSource.withViewport(viewport) : this.coastlineSource;
    try {
      return {
        data: await coastline.apply(base, await coastlineSource.getCoastline()),
        satelliteObservedAt: null,
      };
    } catch (error) {
      this.logger.warn({ err: error }, "Lightning coastline background unavailable; using grid fallback");
      return { data: base, satelliteObservedAt: null };
    }
  }

  private async createBase(options: LightningServiceOptions): Promise<Uint8Array> {
    const grid = [0.2, 0.4, 0.6, 0.8].flatMap((fraction) => [
      `<path d="M${Math.round(options.width * fraction)} 0V${options.height}"/>`,
      `<path d="M0 ${Math.round(options.height * fraction)}H${options.width}"/>`,
    ]).join("\n");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}">
      <rect width="100%" height="100%" fill="#263f4b"/>
      <g fill="none" stroke="#c8dbe1" stroke-opacity="0.14" stroke-width="1">${grid}</g>
    </svg>`;
    return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
  }

  private async dimSatellite(image: Uint8Array, options: LightningServiceOptions): Promise<Uint8Array> {
    const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}">
      <rect width="100%" height="100%" fill="#07151c" fill-opacity="0.32"/>
    </svg>`;
    return new Uint8Array(await sharp(image)
      .composite([{ input: Buffer.from(overlay) }])
      .png()
      .toBuffer());
  }

  private async addFlashes(
    image: Uint8Array,
    flashes: readonly LightningFlash[],
    fetchedAt: Date,
    options: LightningServiceOptions,
    satelliteObservedAt: Date | null,
  ): Promise<Uint8Array> {
    const time = formatTime(fetchedAt, options.timeZone);
    const backgroundTime = satelliteObservedAt
      ? `Спутник ${formatTime(satelliteObservedAt, options.timeZone)} МСК · LI ${time} МСК`
      : `Вспышки MTG Lightning Imager · ${time} МСК`;
    const points = flashes.map((flash) => this.renderFlash(flash, fetchedAt, options)).join("\n");
    const empty = flashes.length === 0
      ? `<text x="24" y="76" fill="#e6f1f4" font-family="Noto Sans, sans-serif" font-size="15" font-weight="600">За последние ${options.windowMinutes} мин вспышек в этом охвате не зарегистрировано</text>`
      : "";
    const legend = flashes.length > 0 ? `<g transform="translate(24 ${options.height - 26})">
      <circle cx="4" cy="-4" r="4" fill="#ff5252" stroke="#ffffff" stroke-width="1"/>
      <text x="13" y="0" fill="#ffffff" stroke="#17242b" stroke-width="2" paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="12" font-weight="600">до 5 мин</text>
      <circle cx="94" cy="-4" r="4" fill="#ff9800" stroke="#ffffff" stroke-width="1"/>
      <text x="103" y="0" fill="#ffffff" stroke="#17242b" stroke-width="2" paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="12" font-weight="600">5–15 мин</text>
      <circle cx="194" cy="-4" r="4" fill="#ffd54f" stroke="#ffffff" stroke-width="1"/>
      <text x="203" y="0" fill="#ffffff" stroke="#17242b" stroke-width="2" paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="12" font-weight="600">старше</text>
    </g>` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}">
      <g>
        <rect x="12" y="12" width="470" height="40" rx="3" fill="#101820" fill-opacity="0.88"/>
        <text x="24" y="29" fill="#ffffff" font-family="Noto Sans, sans-serif" font-size="14" font-weight="700">ГРОЗОВАЯ АКТИВНОСТЬ · ПОСЛЕДНИЕ ${options.windowMinutes} МИН</text>
        <text x="24" y="45" fill="#d8e5e9" font-family="Noto Sans, sans-serif" font-size="12">${backgroundTime}</text>
      </g>
      ${empty}
      ${points}
      ${legend}
    </svg>`;
    const data = await sharp(image).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    if (data.byteLength > options.maxImageBytes) {
      throw new Error(`Lightning map exceeds ${options.maxImageBytes} bytes`);
    }
    return new Uint8Array(data);
  }

  private renderFlash(
    flash: LightningFlash,
    fetchedAt: Date,
    options: LightningServiceOptions,
  ): string {
    const [x, y] = project(flash.longitude, flash.latitude, options.bbox, options.width, options.height);
    const ageMinutes = Math.max(0, (fetchedAt.getTime() - flash.observedAt.getTime()) / 60_000);
    const color = ageMinutes <= 5 ? "#ff5252" : ageMinutes <= 15 ? "#ff9800" : "#ffd54f";
    const radius = ageMinutes <= 5 ? 6 : ageMinutes <= 15 ? 5 : 4;
    return `<g>
      <circle cx="${round(x)}" cy="${round(y)}" r="${radius + 2}" fill="#17242b" fill-opacity="0.82"/>
      <circle cx="${round(x)}" cy="${round(y)}" r="${radius}" fill="${color}" stroke="#ffffff" stroke-width="1"/>
    </g>`;
  }

  private caption(
    flashes: readonly LightningFlash[],
    fetchedAt: Date,
    options: LightningServiceOptions,
    satelliteObservedAt: Date | null,
  ): string {
    const header = `Кемь — Кандалакша · вспышки за последние ${options.windowMinutes} мин · ${formatTime(fetchedAt, options.timeZone)} МСК`;
    const background = satelliteObservedAt
      ? `\nСпутниковая подложка: EUMETView · ${formatTime(satelliteObservedAt, options.timeZone)} МСК.`
      : "\nСпутниковая подложка временно недоступна: показана карта берегов.";
    if (flashes.length === 0) {
      return `${header}\nВспышек в текущем охвате не зарегистрировано.${background}\nИсточник: EUMETSAT MTG Lightning Imager (LI).`;
    }
    const nearest = nearestControlPoint(flashes, this.points);
    const nearestText = nearest
      ? ` Ближайшая к ${nearest.point.shortName}: ${Math.round(nearest.distanceKm)} км, ${formatTime(nearest.flash.observedAt, options.timeZone)} МСК.`
      : "";
    return `${header}\nЗарегистрировано вспышек: ${flashes.length}.${nearestText}${background}\nИсточник: EUMETSAT MTG Lightning Imager (LI). Это спутниковые оптические вспышки, не точные наземные удары.`;
  }
}

function nearestControlPoint(
  flashes: readonly LightningFlash[],
  points: readonly ControlPoint[],
): { flash: LightningFlash; point: ControlPoint; distanceKm: number } | null {
  let nearest: { flash: LightningFlash; point: ControlPoint; distanceKm: number } | null = null;
  for (const flash of flashes) {
    for (const point of points) {
      if (!point.active) continue;
      const distanceKm = distanceBetween(flash.latitude, flash.longitude, point.latitude, point.longitude);
      if (!nearest || distanceKm < nearest.distanceKm) nearest = { flash, point, distanceKm };
    }
  }
  return nearest;
}

function distanceBetween(
  leftLatitude: number,
  leftLongitude: number,
  rightLatitude: number,
  rightLongitude: number,
): number {
  const radians = Math.PI / 180;
  const deltaLatitude = (rightLatitude - leftLatitude) * radians;
  const deltaLongitude = (rightLongitude - leftLongitude) * radians;
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(leftLatitude * radians) * Math.cos(rightLatitude * radians)
    * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function project(
  longitude: number,
  latitude: number,
  bbox: [number, number, number, number],
  width: number,
  height: number,
): [number, number] {
  const [west, south, east, north] = bbox;
  return [
    (longitude - west) / (east - west) * width,
    (north - latitude) / (north - south) * height,
  ];
}

function viewportKey(viewport: MapViewport | undefined): string {
  return viewport ? `${viewport.bbox.join(",")}:${viewport.width}x${viewport.height}` : "default";
}

function formatTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function filenameTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
