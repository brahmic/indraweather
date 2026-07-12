import * as SunCalc from "suncalc";
import type { ImageAttachment } from "../delivery/types.js";
import type { MapViewport } from "../domain/map-viewport.js";
import type { EumetviewClient, SatelliteLayer } from "../infrastructure/eumetview.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";
import type { WindOverlayService } from "./wind-overlay-service.js";

export interface CloudDiagnosticOptions {
  latitude: number;
  longitude: number;
  timeZone: string;
}

export type CloudAnimationMode = "cloudtype" | "fog";

export interface CloudAnimationFrame {
  attachment: ImageAttachment;
  mode: CloudAnimationMode;
}

export class CloudDiagnosticService {
  constructor(
    private readonly images: EumetviewClient,
    private readonly coastline: CoastlineOverlayService,
    private readonly windOverlay: WindOverlayService,
    private readonly options: CloudDiagnosticOptions,
  ) {}

  async getLatest(now = new Date(), viewport?: MapViewport): Promise<ImageAttachment> {
    const layer = this.selectLayer(now);
    return this.getLatestForLayer(layer, true, viewport);
  }

  async getLatestForAnimation(now = new Date()): Promise<CloudAnimationFrame> {
    const layer = this.selectLayer(now);
    return {
      attachment: await this.getLatestForLayer(layer, false),
      mode: modeForLayer(layer),
    };
  }

  getAnimationMode(now = new Date()): CloudAnimationMode {
    return modeForLayer(this.selectLayer(now));
  }

  private async getLatestForLayer(
    layer: SatelliteLayer,
    includeMapContext: boolean,
    viewport?: MapViewport,
  ): Promise<ImageAttachment> {
    const images = viewport ? this.images.withViewport(viewport) : this.images;
    const coastline = viewport ? this.coastline.withViewport(viewport) : this.coastline;
    const windOverlay = viewport ? this.windOverlay.withViewport(viewport) : this.windOverlay;
    const metadata = await images.getLatestMetadata(layer);
    const image = await images.getImage(layer, metadata.observedAt);
    const coastlined = await coastline.apply(
      image.data,
      await images.getCoastline(),
      { includeMapContext },
    );
    const data = includeMapContext
      ? await windOverlay.apply(coastlined, metadata.observedAt)
      : coastlined;
    const isDay = layer.name === DAY_LAYER.name;
    const mode = isDay ? "типы облаков" : "туман и низкая облачность";
    return {
      kind: "image",
      data,
      contentType: "image/png",
      filename: `clouds-${isDay ? "type" : "fog"}-${fileTime(metadata.observedAt)}.png`,
      caption: `Кемь - Кандалакша · ${mode} · ${formatTime(metadata.observedAt, this.options.timeZone)} МСК\nИсточник: EUMETSAT EUMETView`,
      source: "EUMETSAT EUMETView",
      observedAt: metadata.observedAt,
    };
  }

  private selectLayer(now: Date): SatelliteLayer {
    const altitude = SunCalc.getPosition(now, this.options.latitude, this.options.longitude).altitude;
    return altitude > 0 ? DAY_LAYER : NIGHT_LAYER;
  }
}

const DAY_LAYER: SatelliteLayer = { name: "mtg_fd:rgb_cloudtype", mode: "day" };
const NIGHT_LAYER: SatelliteLayer = { name: "mtg_fd:rgb_fog", mode: "night" };

function modeForLayer(layer: SatelliteLayer): CloudAnimationMode {
  return layer.name === DAY_LAYER.name ? "cloudtype" : "fog";
}

function fileTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}

function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
