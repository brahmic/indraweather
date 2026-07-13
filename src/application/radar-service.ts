import type { ImageAttachment } from "../delivery/types.js";
import type { MapViewport } from "../domain/map-viewport.js";
import type { CopernicusRadarClient } from "../infrastructure/copernicus-radar.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";
import type { EumetviewClient } from "../infrastructure/eumetview.js";
import type { WindOverlayService } from "./wind-overlay-service.js";
import { BoundedTtlCache } from "./bounded-ttl-cache.js";

export interface RadarServiceOptions {
  cacheMinutes: number;
  cacheMaxEntries: number;
}

interface CachedRadarImage {
  data: Uint8Array;
  observedAt: Date;
}

export class RadarService {
  private readonly cached: BoundedTtlCache<CachedRadarImage>;

  constructor(
    private readonly radar: CopernicusRadarClient,
    private readonly coastline: CoastlineOverlayService,
    private readonly coastlineSource: EumetviewClient,
    private readonly windOverlay: WindOverlayService,
    private readonly timeZone: string,
    private readonly options: RadarServiceOptions,
  ) {
    this.cached = new BoundedTtlCache(
      options.cacheMinutes * 60_000,
      options.cacheMaxEntries,
    );
  }

  async getLatest(viewport?: MapViewport): Promise<ImageAttachment> {
    const now = new Date();
    const image = await this.cached.getOrLoad(`radar:${viewportKey(viewport)}`, now, async () => {
      const source = await this.radar.getLatest(now, viewport);
      const coastline = viewport ? this.coastline.withViewport(viewport) : this.coastline;
      const coastlineSource = viewport ? this.coastlineSource.withViewport(viewport) : this.coastlineSource;
      return {
        data: await coastline.apply(source.data, await coastlineSource.getCoastline()),
        observedAt: source.observedAt,
      };
    });
    const windOverlay = viewport ? this.windOverlay.withViewport(viewport) : this.windOverlay;
    const data = await windOverlay.apply(image.data, image.observedAt);
    const time = new Intl.DateTimeFormat("ru-RU", {
      timeZone: this.timeZone,
      day: "2-digit",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(image.observedAt);
    return {
      kind: "image",
      data,
      contentType: "image/png",
      filename: `sentinel-1-radar-${image.observedAt.toISOString().replaceAll(":", "-").replace(".000Z", "Z")}.png`,
      caption: `Кандалакшский залив · радар Sentinel-1 · ${time} МСК\nРадар видит поверхность сквозь облака; интерпретация льда требует осторожности.\nИсточник: Copernicus Data Space`,
      source: "Copernicus Data Space Sentinel-1",
      observedAt: image.observedAt,
    };
  }
}

function viewportKey(viewport: MapViewport | undefined): string {
  return viewport ? `${viewport.bbox.join(",")}:${viewport.width}x${viewport.height}` : "default";
}
