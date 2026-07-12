import sharp from "sharp";
import type { ImageAttachment } from "../delivery/types.js";
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

export class DetailedSatelliteService {
  private cached: { result: DetailedSatelliteResult; cachedAt: Date } | null = null;

  constructor(
    private readonly catalog: EumetsatCatalogClient,
    private readonly images: EumetviewClient,
    private readonly coastlineOverlay: CoastlineOverlayService,
    private readonly windOverlay: WindOverlayService,
    private readonly passes: SentinelPassService,
    private readonly options: DetailedSatelliteOptions,
  ) {}

  async getLatest(now = new Date()): Promise<DetailedSatelliteResult> {
    if (this.cached && now.getTime() - this.cached.cachedAt.getTime()
      < this.options.cacheMinutes * 60_000) return this.cached.result;

    let result: DetailedSatelliteResult;
    try {
      result = await this.load(now);
    } catch {
      result = await this.skipped({ code: "source-unavailable" }, now);
    }
    this.cached = { result, cachedAt: now };
    return result;
  }

  private async load(now: Date): Promise<DetailedSatelliteResult> {
    const products = await this.catalog.findProducts(
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
        const image = await this.images.getImage(layerFor(product.platform), product.observedAt);
        const coveragePercent = await imageCoveragePercent(image.data);
        evaluatedImages += 1;
        bestCoverage = Math.max(bestCoverage, coveragePercent);
        if (coveragePercent < this.options.minCoveragePercent) continue;
        return {
          status: "available",
          coveragePercent,
          attachment: await this.attachment(product, image.data, coveragePercent),
          partial: coveragePercent < this.options.preferredCoveragePercent
            ? {
              preferredCoveragePercent: this.options.preferredCoveragePercent,
              nextPassAt: await this.passes.nextPass(now),
            }
            : null,
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

  private async attachment(
    product: SentinelProduct,
    image: Uint8Array,
    coveragePercent: number,
  ): Promise<ImageAttachment> {
    const flattened = await sharp(image)
      .flatten({ background: "#253238" })
      .png()
      .toBuffer();
    const coastlined = await this.coastlineOverlay.apply(
      new Uint8Array(flattened),
      await this.images.getCoastline(),
    );
    const data = await this.windOverlay.apply(coastlined, product.observedAt);
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
  ): Promise<DetailedSatelliteResult> {
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
