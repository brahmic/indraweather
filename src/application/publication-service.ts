import type { BulletinService, RunBulletinOptions } from "./bulletin-service.js";
import type { DeliveryAttachment, Publication } from "../delivery/types.js";
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

export class PublicationService {
  constructor(
    private readonly bulletins: BulletinService,
    private readonly satellite: SatelliteImageService | null,
    private readonly satelliteAnimation: SatelliteAnimationService | null,
    private readonly detailedSatellite: DetailedSatelliteService | null,
    private readonly clouds: CloudDiagnosticService | null,
    private readonly cloudAnimation: CloudAnimationService | null,
    private readonly radar: RadarService | null,
    private readonly pointForecasts: PointForecastService,
    private readonly timeZone: string,
    private readonly logger: Logger,
  ) {}

  async getFreshOrRun(viewport?: MapViewport, includeAnimations = true): Promise<Publication> {
    return this.create(await this.bulletins.getFreshOrRun(), viewport, includeAnimations);
  }

  async run(options: RunBulletinOptions): Promise<Publication | null> {
    const bulletin = await this.bulletins.run(options);
    return bulletin ? this.create(bulletin) : null;
  }

  async getFreshDetails(): Promise<string> {
    const bulletin = await this.bulletins.getFreshOrRun();
    return renderModelDetails(bulletin.summary, this.timeZone);
  }

  async getPointForecast(pointId: string): Promise<string> {
    return this.pointForecasts.get(pointId);
  }

  async getClouds(viewport?: MapViewport, includeAnimation = true): Promise<DeliveryAttachment[]> {
    if (!this.clouds) throw new Error("Cloud diagnostics are disabled");
    const attachments: DeliveryAttachment[] = [await this.clouds.getLatest(new Date(), viewport)];
    if (includeAnimation && this.cloudAnimation) {
      try {
        const animation = await this.cloudAnimation.getLatest();
        if (animation) attachments.push(animation);
      } catch (error) {
        this.logger.warn({ error }, "Cloud diagnostic animation is unavailable");
      }
    }
    return attachments;
  }

  async getRadar(viewport?: MapViewport) {
    if (!this.radar) throw new Error("Sentinel-1 radar is not configured");
    return this.radar.getLatest(viewport);
  }

  async getMap(viewport: MapViewport): Promise<DeliveryAttachment> {
    if (!this.satellite) throw new Error("Satellite imagery is disabled");
    return this.satellite.getLatest(new Date(), viewport);
  }

  private async create(
    bulletin: BulletinRecord,
    viewport?: MapViewport,
    includeAnimations = true,
  ): Promise<Publication> {
    const attachments: DeliveryAttachment[] = [];
    if (this.satellite) {
      try {
        attachments.push(await this.satellite.getLatest(new Date(), viewport));
      } catch (error) {
        this.logger.warn({ error, bulletinId: bulletin.id }, "Satellite image is unavailable");
      }
    }
    if (includeAnimations && this.satelliteAnimation) {
      try {
        const animation = await this.satelliteAnimation.getLatest();
        if (animation) attachments.push(animation);
      } catch (error) {
        this.logger.warn({ error, bulletinId: bulletin.id }, "Satellite animation is unavailable");
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
    text += "\n\nПодробности по моделям:\n/details";
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
