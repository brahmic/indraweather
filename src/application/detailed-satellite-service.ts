import sharp from "sharp";
import type { ImageAttachment } from "../delivery/types.js";
import type { MapViewport } from "../domain/map-viewport.js";
import type {
  EumetsatCatalogClient,
  SentinelPlatform,
  SentinelProduct,
} from "../infrastructure/eumetsat-catalog.js";
import type { EumetviewClient, SatelliteLayer } from "../infrastructure/eumetview.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";
import type { SentinelPassService } from "./sentinel-pass-service.js";
import type { WindOverlayService } from "./wind-overlay-service.js";

export type DetailedSatelliteSkipReason =
  | { code: "no-products" }
  | { code: "stale"; ageHours: number; maxAgeHours: number }
  | { code: "low-coverage"; coveragePercent: number; minCoveragePercent: number }
  | { code: "source-unavailable" };

export type DetailedSatelliteResult =
  | {
    status: "available";
    attachment: ImageAttachment;
    coveragePercent: number;
    partial: { preferredCoveragePercent: number; nextPassAt: Date | null } | null;
  }
  | { status: "skipped"; reason: DetailedSatelliteSkipReason; nextPassAt: Date | null };

export interface DetailedSatelliteOptions {
  maxAgeHours: number;
  minCoveragePercent: number;
  preferredCoveragePercent: number;
  cacheMinutes: number;
  maxImageBytes: number;
  timeZone: string;
}

type CachedDetailedSatelliteResult =
  | {
    status: "available";
    product: SentinelProduct;
    image: Uint8Array;
    coveragePercent: number;
    partial: { preferredCoveragePercent: number; nextPassAt: Date | null } | null;
  }
  | { status: "skipped"; reason: DetailedSatelliteSkipReason; nextPassAt: Date | null };

export class DetailedSatelliteService {
  private cached: { result: CachedDetailedSatelliteResult; cachedAt: Date } | null = null;

  constructor(
    private readonly catalog: EumetsatCatalogClient,
    private readonly images: EumetviewClient,
    private readonly coastlineOverlay: CoastlineOverlayService,
    private readonly windOverlay: WindOverlayService,
    private readonly passes: SentinelPassService,
    private readonly options: DetailedSatelliteOptions,
  ) {}

  async getLatest(now = new Date(), viewport?: MapViewport): Promise<DetailedSatelliteResult> {
    let result = !viewport && this.cached && now.getTime() - this.cached.cachedAt.getTime()
      < this.options.cacheMinutes * 60_000
      ? this.cached.result
      : null;
    if (!result) {
      try {
        result = await this.load(now, viewport);
      } catch {
        result = await this.skipped({ code: "source-unavailable" }, now);
      }
      if (!viewport) this.cached = { result, cachedAt: now };
    }
    return this.render(result, now, viewport);
  }

  private async load(now: Date, viewport?: MapViewport): Promise<CachedDetailedSatelliteResult> {
    const catalog = viewport ? this.catalog.withViewport(viewport) : this.catalog;
    const images = viewport ? this.images.withViewport(viewport) : this.images;
    const coastlineOverlay = viewport ? this.coastlineOverlay.withViewport(viewport) : this.coastlineOverlay;
    const products = await catalog.findProducts(
      new Date(now.getTime() - 48 * 3_600_000),
      now,
    );
    const newest = products[0];
    if (!newest) return this.skipped({ code: "no-products" }, now);
    const newestAgeHours = (now.getTime() - newest.observedAt.getTime()) / 3_600_000;
    if (newestAgeHours > this.options.maxAgeHours) {
      return this.skipped({
        code: "stale",
        ageHours: newestAgeHours,
        maxAgeHours: this.options.maxAgeHours,
      }, now);
    }

    let bestCoverage = 0;
    let evaluatedImages = 0;
    let imageErrors = 0;
    for (const product of products) {
      const ageHours = (now.getTime() - product.observedAt.getTime()) / 3_600_000;
      if (ageHours > this.options.maxAgeHours) continue;
      try {
        const image = await images.getImage(layerFor(product.platform), product.observedAt);
        const coveragePercent = await imageCoveragePercent(image.data);
        evaluatedImages += 1;
        bestCoverage = Math.max(bestCoverage, coveragePercent);
        if (coveragePercent < this.options.minCoveragePercent) continue;
        const partial = coveragePercent < this.options.preferredCoveragePercent
          ? {
            preferredCoveragePercent: this.options.preferredCoveragePercent,
            nextPassAt: await this.passes.nextPass(now),
          }
          : null;
        return {
          status: "available",
          product,
          coveragePercent,
          image: await this.prepareImage(image.data, images, coastlineOverlay),
          partial,
        };
      } catch {
        imageErrors += 1;
      }
    }
    if (evaluatedImages > 0) {
      return this.skipped({
        code: "low-coverage",
        coveragePercent: bestCoverage,
        minCoveragePercent: this.options.minCoveragePercent,
      }, now);
    }
    return this.skipped(imageErrors > 0 ? { code: "source-unavailable" } : { code: "no-products" }, now);
  }

  private async render(
    result: CachedDetailedSatelliteResult,
    now: Date,
    viewport?: MapViewport,
  ): Promise<DetailedSatelliteResult> {
    if (result.status === "skipped") return result;
    const windOverlay = viewport ? this.windOverlay.withViewport(viewport) : this.windOverlay;
    const image = await windOverlay.apply(result.image, result.product.observedAt);
    return {
      status: "available",
      coveragePercent: result.coveragePercent,
      attachment: await this.attachment(
        result.product,
        image,
        result.coveragePercent,
        now,
        result.partial !== null,
      ),
      partial: result.partial,
    };
  }

  private async prepareImage(
    image: Uint8Array,
    images: EumetviewClient,
    coastlineOverlay: CoastlineOverlayService,
  ): Promise<Uint8Array> {
    const flattened = await sharp(image)
      .flatten({ background: "#253238" })
      .png()
      .toBuffer();
    return coastlineOverlay.apply(
      new Uint8Array(flattened),
      await images.getCoastline(),
    );
  }

  private async attachment(
    product: SentinelProduct,
    image: Uint8Array,
    coveragePercent: number,
    now: Date,
    partial: boolean,
  ): Promise<ImageAttachment> {
    const data = await this.addFlightOverlay(image, product, coveragePercent, now, partial);
    if (data.byteLength > this.options.maxImageBytes) {
      throw new Error(`Detailed satellite image exceeds ${this.options.maxImageBytes} bytes`);
    }
    return {
      kind: "image",
      data,
      contentType: "image/png",
      filename: `sentinel-3-detail-${filenameTime(product.observedAt)}.png`,
      caption: this.caption(product, coveragePercent),
      source: "EUMETSAT Sentinel-3 OLCI / EUMETView",
      observedAt: product.observedAt,
    };
  }

  private async addFlightOverlay(
    image: Uint8Array,
    product: SentinelProduct,
    coveragePercent: number,
    now: Date,
    partial: boolean,
  ): Promise<Uint8Array> {
    const metadata = await sharp(image).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height || width < 320 || height < 160) return image;
    const panelWidth = Math.min(width - 24, 580);
    const panelHeight = 58;
    const panelX = 12;
    const panelY = height - panelHeight - 12;
    const observedAt = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.options.timeZone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(product.observedAt);
    const ageHours = Math.max(0, (now.getTime() - product.observedAt.getTime()) / 3_600_000);
    const warning = partial ? `<g transform="translate(${panelX + panelWidth - 34} ${panelY + 12})">
      <path d="M11 0 L22 20 H0 Z" fill="#ffd54f" stroke="#17242b" stroke-width="1.5"/>
      <text x="11" y="15" text-anchor="middle" fill="#17242b" font-family="Noto Sans, sans-serif" font-size="14" font-weight="800">!</text>
    </g>` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <g>
        <rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="3" fill="#101820" fill-opacity="0.88"/>
        <text x="${panelX + 12}" y="${panelY + 21}" fill="#ffffff" font-family="Noto Sans, sans-serif" font-size="14" font-weight="700">SENTINEL-3 ${product.platform === "Sentinel-3A" ? "A" : "B"} · ДЕТАЛЬНЫЙ СНИМОК</text>
        <text x="${panelX + 12}" y="${panelY + 43}" fill="#d8e5e9" font-family="Noto Sans, sans-serif" font-size="12" font-weight="600">ПРОЛЁТ: ${observedAt} МСК · ВОЗРАСТ: ${formatFlightAge(ageHours)} · ПОКРЫТИЕ: ${Math.round(coveragePercent)}%</text>
        ${warning}
      </g>
    </svg>`;
    return new Uint8Array(await sharp(image).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
  }

  private caption(product: SentinelProduct, coveragePercent: number): string {
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.options.timeZone,
      day: "2-digit",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(product.observedAt);
    return `Кандалакшский залив крупно · Sentinel-3 OLCI · ${time} МСК · покрытие ${Math.round(coveragePercent)}%\nИсточник: EUMETSAT EUMETView`;
  }

  private async skipped(
    reason: DetailedSatelliteSkipReason,
    now: Date,
  ): Promise<Extract<CachedDetailedSatelliteResult, { status: "skipped" }>> {
    return { status: "skipped", reason, nextPassAt: await this.passes.nextPass(now) };
  }
}

export async function imageCoveragePercent(image: Uint8Array): Promise<number> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let covered = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    if ((data[index] ?? 0) > 0) covered += 1;
  }
  return covered / (info.width * info.height) * 100;
}

function layerFor(platform: SentinelPlatform): SatelliteLayer {
  return {
    name: platform === "Sentinel-3A"
      ? "copernicus:sentinel3a_olci_l1_rgb_fullres"
      : "copernicus:sentinel3b_olci_l1_rgb_fullres",
    mode: "day",
    transparent: true,
  };
}

function filenameTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}

function formatFlightAge(hours: number): string {
  return hours < 1 ? "менее 1 ч" : `${Math.round(hours)} ч`;
}
