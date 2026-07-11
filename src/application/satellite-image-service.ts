import * as SunCalc from "suncalc";
import type { ImageAttachment } from "../delivery/types.js";
import type { EumetviewClient, SatelliteLayer } from "../infrastructure/eumetview.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";

export interface SatelliteImageOptions {
  latitude: number;
  longitude: number;
  maxAgeMinutes: number;
  cacheMinutes: number;
  timeZone: string;
}

export class SatelliteImageService {
  private readonly cached = new Map<string, { attachment: ImageAttachment; cachedAt: Date }>();

  constructor(
    private readonly client: EumetviewClient,
    private readonly coastlineOverlay: CoastlineOverlayService,
    private readonly options: SatelliteImageOptions,
  ) {}

  async getLatest(now = new Date()): Promise<ImageAttachment> {
    return this.getLatestForLayer(this.selectLayer(now), now);
  }

  async getLatestInfrared(now = new Date()): Promise<ImageAttachment> {
    return this.getLatestForLayer(this.client.nightLayer, now);
  }

  private async getLatestForLayer(layer: SatelliteLayer, now: Date): Promise<ImageAttachment> {
    const cached = this.cached.get(layer.name);
    if (cached && now.getTime() - cached.cachedAt.getTime() < this.options.cacheMinutes * 60_000) {
      return cached.attachment;
    }
    const metadata = await this.client.getLatestMetadata(layer);
    const ageMinutes = (now.getTime() - metadata.observedAt.getTime()) / 60_000;
    if (ageMinutes > this.options.maxAgeMinutes) {
      throw new Error(`Latest EUMETSAT image is ${Math.round(ageMinutes)} minutes old`);
    }
    const image = await this.client.getImage(layer, metadata.observedAt);
    const data = await this.coastlineOverlay.apply(
      image.data,
      await this.client.getCoastline(),
    );
    const attachment: ImageAttachment = {
      kind: "image",
      data,
      contentType: image.contentType,
      filename: `eumetsat-${layer.mode}-${filenameTime(metadata.observedAt)}.png`,
      caption: this.caption(layer, metadata.observedAt),
      source: "EUMETSAT EUMETView",
      observedAt: metadata.observedAt,
    };
    this.cached.set(layer.name, { attachment, cachedAt: now });
    return attachment;
  }

  private selectLayer(now: Date): SatelliteLayer {
    const sunAltitude = SunCalc.getPosition(
      now,
      this.options.latitude,
      this.options.longitude,
    ).altitude;
    return sunAltitude > 0 ? this.client.dayLayer : this.client.nightLayer;
  }

  private caption(layer: SatelliteLayer, observedAt: Date): string {
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.options.timeZone,
      day: "2-digit",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(observedAt);
    const mode = layer.mode === "day" ? "естественные цвета" : "инфракрасный канал";
    return `Кемь — Кандалакша · спутниковый снимок (${mode}) · ${time} МСК\nИсточник: EUMETSAT EUMETView`;
  }
}

function filenameTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}
