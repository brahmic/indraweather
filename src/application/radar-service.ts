import type { ImageAttachment } from "../delivery/types.js";
import type { CopernicusRadarClient } from "../infrastructure/copernicus-radar.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";
import type { EumetviewClient } from "../infrastructure/eumetview.js";

export class RadarService {
  constructor(
    private readonly radar: CopernicusRadarClient,
    private readonly coastline: CoastlineOverlayService,
    private readonly coastlineSource: EumetviewClient,
    private readonly timeZone: string,
  ) {}

  async getLatest(): Promise<ImageAttachment> {
    const image = await this.radar.getLatest();
    const data = await this.coastline.apply(image.data, await this.coastlineSource.getCoastline());
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
