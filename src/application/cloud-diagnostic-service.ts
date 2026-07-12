import * as SunCalc from "suncalc";
import type { ImageAttachment } from "../delivery/types.js";
import type { EumetviewClient, SatelliteLayer } from "../infrastructure/eumetview.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";

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
    private readonly options: CloudDiagnosticOptions,
  ) {}

  async getLatest(now = new Date()): Promise<ImageAttachment> {
    const layer = this.selectLayer(now);
    return this.getLatestForLayer(layer, true);
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
  ): Promise<ImageAttachment> {
    const metadata = await this.images.getLatestMetadata(layer);
    const image = await this.images.getImage(layer, metadata.observedAt);
    const data = await this.coastline.apply(
      image.data,
      await this.images.getCoastline(),
      { includeMapContext },
    );
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
