import type { BulletinService, RunBulletinOptions } from "./bulletin-service.js";
import type { AnimationAttachment, DeliveryAttachment, Publication } from "../delivery/types.js";
import type { SatelliteAnimationService } from "./satellite-animation-service.js";
import type { CloudDiagnosticService } from "./cloud-diagnostic-service.js";
import type { CloudAnimationService } from "./cloud-animation-service.js";
import type { RadarService } from "./radar-service.js";
import type { SatelliteImageService } from "./satellite-image-service.js";
import type {
  DetailedSatelliteResult,
  DetailedSatelliteService,
} from "./detailed-satellite-service.js";
import type { BulletinRecord } from "../infrastructure/database.js";
import type { Logger } from "../logger.js";
import type { MapViewport } from "../domain/map-viewport.js";
import { renderModelDetails } from "../domain/model-details.js";
import type { PointForecastService } from "./point-forecast-service.js";
import type { ForecastMapService } from "./forecast-map-service.js";

export interface DetailsPublication {
  text: string;
  attachments: DeliveryAttachment[];
}

export class PublicationService {
  constructor(
    private readonly bulletins: BulletinService,
    private readonly satellite: SatelliteImageService | null,
    private readonly satelliteAnimation: SatelliteAnimationService | null,
    private readonly detailedSatellite: DetailedSatelliteService | null,
    private readonly clouds: CloudDiagnosticService | null,
    private readonly cloudAnimation: CloudAnimationService | null,
    private readonly radar: RadarService | null,
    private readonly forecastMap: ForecastMapService | null,
    private readonly pointForecasts: PointForecastService,
    private readonly timeZone: string,
    private readonly logger: Logger,
  ) {}

  async getFreshOrRun(viewport?: MapViewport): Promise<Publication> {
    return this.create(await this.bulletins.getFreshOrRun(), viewport);
  }

  async run(options: RunBulletinOptions, viewport?: MapViewport): Promise<Publication | null> {
    const bulletin = await this.bulletins.run(options);
    return bulletin ? this.create(bulletin, viewport) : null;
  }

  async getFreshDetails(): Promise<DetailsPublication> {
    const bulletin = await this.bulletins.getFreshOrRun();
    const attachments: DeliveryAttachment[] = [];
    if (this.forecastMap) {
      try {
        attachments.push(await this.forecastMap.get(bulletin.runId, bulletin.createdAt));
      } catch (error) {
        this.logger.warn({ error, bulletinId: bulletin.id }, "Forecast map is unavailable");
      }
    }
    return {
      text: renderModelDetails(bulletin.summary, this.timeZone),
      attachments,
    };
  }

  async getPointForecast(pointId: string): Promise<string> {
    return this.pointForecasts.get(pointId);
  }

  async getSatelliteAnimation(): Promise<AnimationAttachment> {
    if (!this.satelliteAnimation) throw new Error("Satellite animation is disabled");
    const animation = await this.satelliteAnimation.getLatest();
    if (!animation) throw new Error("Satellite animation does not have enough frames");
    return animation;
  }

  async getClouds(viewport?: MapViewport): Promise<DeliveryAttachment[]> {
    if (!this.clouds) throw new Error("Cloud diagnostics are disabled");
    const diagnostic = this.clouds.getLatest(new Date(), viewport);
    const infrared = this.satellite?.getLatestInfraredSnapshot(new Date(), viewport)
      .catch((error: unknown) => {
        this.logger.warn({ error }, "Infrared cloud image is unavailable");
        return null;
      });
    const detailed = this.detailedSatellite?.getLatest(new Date(), viewport)
      .then((result) => result.status === "available" ? result.attachment : null)
      .catch((error: unknown) => {
        this.logger.warn({ error }, "Detailed cloud image is unavailable");
        return null;
      });
    const attachments: DeliveryAttachment[] = [await diagnostic];
    if (infrared) {
      const image = await infrared;
      if (image) attachments.push(image);
    }
    if (detailed) {
      const image = await detailed;
      if (image) attachments.push(image);
    }
    return attachments;
  }

  async getCloudMotionAnimations(): Promise<AnimationAttachment[]> {
    const results = await Promise.allSettled([
      this.getSatelliteAnimation(),
      this.getCloudDiagnosticAnimation(),
    ]);
    const animations = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn({ error: result.reason }, "Cloud motion animation is unavailable");
      }
    }
    if (animations.length === 0) throw new Error("Cloud motion animations are unavailable");
    return animations;
  }

  async getRadar(viewport?: MapViewport) {
    if (!this.radar) throw new Error("Sentinel-1 radar is not configured");
    return this.radar.getLatest(viewport);
  }

  async getMap(viewport: MapViewport): Promise<DeliveryAttachment> {
    if (!this.satellite) throw new Error("Satellite imagery is disabled");
    return this.satellite.getLatest(new Date(), viewport);
  }

  private async getCloudDiagnosticAnimation(): Promise<AnimationAttachment> {
    if (!this.cloudAnimation) throw new Error("Cloud diagnostic animation is disabled");
    const animation = await this.cloudAnimation.getLatest();
    if (!animation) throw new Error("Cloud diagnostic animation does not have enough frames");
    return animation;
  }

  private async create(
    bulletin: BulletinRecord,
    viewport?: MapViewport,
  ): Promise<Publication> {
    const attachments: DeliveryAttachment[] = [];
    if (this.satellite) {
      try {
        attachments.push(await this.satellite.getLatest(new Date(), viewport));
      } catch (error) {
        this.logger.warn({ error, bulletinId: bulletin.id }, "Satellite image is unavailable");
      }
    }
    let text = bulletin.content;
    if (this.detailedSatellite) {
      const detail = await this.detailedSatellite.getLatest(new Date(), viewport);
      if (detail.status === "available") {
        attachments.push(detail.attachment);
        if (detail.partial) text += `\n\n${formatDetailedSatellitePartial(detail, this.timeZone)}`;
      } else {
        if (detail.reason.code === "source-unavailable") {
          this.logger.warn(
            { bulletinId: bulletin.id },
            "Detailed satellite image source is unavailable",
          );
        }
        text += `\n\n${formatDetailedSatelliteSkip(detail, this.timeZone)}`;
      }
    }
    return {
      id: bulletin.id,
      text,
      attachments,
    };
  }
}

export function formatDetailedSatellitePartial(
  result: Extract<DetailedSatelliteResult, { status: "available" }>,
  timeZone: string,
): string {
  const partial = result.partial;
  if (!partial) return "";
  const nextPass = partial.nextPassAt
    ? ` Расчётный следующий дневной пролёт: ${formatLocalTime(partial.nextPassAt, timeZone)} МСК.`
    : " Время следующего пролёта определить не удалось.";
  return `Детальный снимок неполный: данные есть только для части залива, покрытие ${Math.round(result.coveragePercent)}% при желательном ${Math.round(partial.preferredCoveragePercent)}%.${nextPass}`;
}

export function formatDetailedSatelliteSkip(
  result: Extract<DetailedSatelliteResult, { status: "skipped" }>,
  timeZone: string,
): string {
  let reason: string;
  switch (result.reason.code) {
    case "stale":
      reason = `последнему снимку ${formatAge(result.reason.ageHours)} при допустимых ${formatAge(result.reason.maxAgeHours)}`;
      break;
    case "low-coverage":
      reason = `покрытие залива ${Math.round(result.reason.coveragePercent)}% при требуемых ${Math.round(result.reason.minCoveragePercent)}%`;
      break;
    case "no-products":
      reason = "за последние 48 часов подходящих пролётов в каталоге нет";
      break;
    case "source-unavailable":
      reason = "источник снимков временно недоступен";
  }
  const nextPass = result.nextPassAt
    ? ` Расчётный следующий дневной пролёт: ${formatLocalTime(result.nextPassAt, timeZone)} МСК.`
    : " Время следующего пролёта определить не удалось.";
  return `Детальный снимок Sentinel-3 пропущен: ${reason}.${nextPass}`;
}

function formatAge(hours: number): string {
  return hours < 24 ? `${Math.round(hours)} ч` : `${Math.round(hours / 24)} сут`;
}

function formatLocalTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
