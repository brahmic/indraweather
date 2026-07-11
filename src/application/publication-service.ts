import type { BulletinService, RunBulletinOptions } from "./bulletin-service.js";
import type { Publication } from "../delivery/types.js";
import type { SatelliteImageService } from "./satellite-image-service.js";
import type {
  DetailedSatelliteResult,
  DetailedSatelliteService,
} from "./detailed-satellite-service.js";
import type { BulletinRecord } from "../infrastructure/database.js";
import type { Logger } from "../logger.js";
import { renderModelDetails } from "../domain/model-details.js";

export class PublicationService {
  constructor(
    private readonly bulletins: BulletinService,
    private readonly satellite: SatelliteImageService | null,
    private readonly detailedSatellite: DetailedSatelliteService | null,
    private readonly timeZone: string,
    private readonly logger: Logger,
  ) {}

  async getFreshOrRun(): Promise<Publication> {
    return this.create(await this.bulletins.getFreshOrRun());
  }

  async run(options: RunBulletinOptions): Promise<Publication | null> {
    const bulletin = await this.bulletins.run(options);
    return bulletin ? this.create(bulletin) : null;
  }

  async getFreshDetails(): Promise<string> {
    const bulletin = await this.bulletins.getFreshOrRun();
    return renderModelDetails(bulletin.summary, this.timeZone);
  }

  private async create(bulletin: BulletinRecord): Promise<Publication> {
    const attachments = [];
    if (this.satellite) {
      try {
        attachments.push(await this.satellite.getLatest());
      } catch (error) {
        this.logger.warn({ error, bulletinId: bulletin.id }, "Satellite image is unavailable");
      }
    }
    let text = bulletin.content;
    if (this.detailedSatellite) {
      const detail = await this.detailedSatellite.getLatest();
      if (detail.status === "available") {
        attachments.push(detail.attachment);
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
