import { analyzeForecast } from "../domain/analysis.js";
import { renderBulletin } from "../domain/bulletin.js";
import type { BulletinRecord, Database } from "../infrastructure/database.js";
import type { OpenMeteoClient } from "../infrastructure/open-meteo.js";
import type { OpenMeteoMarineClient } from "../infrastructure/open-meteo-marine.js";
import type { StormglassClient } from "../infrastructure/stormglass.js";
import type { KolgimetClient } from "../infrastructure/kolgimet.js";
import type { AppConfig } from "../config.js";
import type { ControlPoint, ForecastValue, MarinePointSummary, WeatherModel } from "../domain/types.js";
import type { Logger } from "../logger.js";
import { WEATHER_MODELS } from "../domain/types.js";

export interface RunBulletinOptions {
  kind: "scheduled" | "manual";
  scheduledFor?: Date;
}

export class BulletinService {
  constructor(
    private readonly database: Database,
    private readonly weather: OpenMeteoClient,
    private readonly marine: OpenMeteoMarineClient,
    private readonly tides: StormglassClient | null,
    private readonly warnings: KolgimetClient,
    private readonly points: ControlPoint[],
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly nextScheduledAt: () => Date | null,
  ) {}

  async getFreshOrRun(): Promise<BulletinRecord> {
    const latest = await this.database.getLatestBulletin();
    const freshnessMs = this.config.freshForecastMinutes * 60_000;
    if (latest?.contentFormat === "plain"
      && Date.now() - latest.createdAt.getTime() <= freshnessMs) return latest;
    const generated = await this.run({ kind: "manual" });
    if (generated) return generated;
    const fallback = await this.database.getLatestBulletin();
    if (!fallback) throw new Error("Collector is busy and no bulletin exists yet");
    return fallback;
  }

  async run(options: RunBulletinOptions): Promise<BulletinRecord | null> {
    return this.database.withCollectorLock(async () => this.collect(options));
  }

  private async collect(options: RunBulletinOptions): Promise<BulletinRecord> {
    const startedAt = new Date();
    const run = await this.database.createRun(options.kind, options.scheduledFor ?? null);
    const errors: string[] = [];
    try {
      const activePoints = this.points.filter((point) => point.active);
      const requests = activePoints.flatMap((point) =>
        WEATHER_MODELS.map((model) => ({ point, model })));
      const settled = await Promise.allSettled(requests.map(({ point, model }) =>
        this.weather.getForecast(model, point, startedAt)));
      const values: ForecastValue[] = [];
      const successfulModels = new Set<WeatherModel>();
      const successfulPoints: Record<WeatherModel, number> = { ecmwf: 0, gfs: 0 };
      for (const [index, result] of settled.entries()) {
        const request = requests[index];
        if (!request) continue;
        if (result.status === "fulfilled") {
          values.push(...result.value);
          successfulModels.add(request.model);
          successfulPoints[request.model] += 1;
        } else {
          const message = `${request.model}/${request.point.id}: ${errorMessage(result.reason)}`;
          errors.push(message);
          this.logger.warn({ error: message }, "Weather request failed");
        }
      }
      if (successfulModels.size === 0 || values.length === 0) {
        throw new Error("Both weather models are unavailable");
      }
      await this.database.saveForecastValues(run.id, values);

      const warningResult = await this.loadWarnings(errors);
      const tideValues = await this.loadTides(startedAt, errors);
      const marineResult = await this.loadMarine(activePoints, errors);
      const previousSummary = options.kind === "scheduled"
        ? await this.database.getPreviousScheduledSummary()
        : null;
      const summary = analyzeForecast(
        this.points.filter((point) => point.active),
        values,
        startedAt,
        this.config.thresholds,
      );
      const unavailableModels = WEATHER_MODELS.flatMap((model) => {
        const count = successfulPoints[model];
        const label = model.toUpperCase();
        if (count === 0) return [label];
        if (count < activePoints.length) {
          return [`${label} (${activePoints.length - count} точек без данных)`];
        }
        return [];
      });
      const content = renderBulletin({
        summary,
        warnings: warningResult.values,
        tides: tideValues,
        previousSummary,
        nextScheduledAt: this.nextScheduledAt(),
        unavailableModels,
        warningSourceUnavailable: warningResult.unavailable,
        marine: marineResult.values,
        marineSourceUnavailable: marineResult.unavailable,
        timeZone: this.config.timeZone,
      });
      const dedupeKey = options.kind === "scheduled" && options.scheduledFor
        ? `scheduled:${options.scheduledFor.toISOString()}`
        : `manual:${run.id}`;
      const bulletin = await this.database.saveBulletin(
        run.id,
        options.kind,
        dedupeKey,
        content,
        summary,
      );
      await this.database.completeRun(run.id, errors.length > 0 ? "partial" : "succeeded",
        errors.length > 0 ? errors.join(" | ").slice(0, 4000) : null);
      this.logger.info({
        runId: run.id,
        bulletinId: bulletin.id,
        kind: options.kind,
        errors: errors.length,
      }, "Bulletin generated");
      return bulletin;
    } catch (error) {
      await this.database.completeRun(run.id, "failed", errorMessage(error).slice(0, 4000));
      throw error;
    }
  }

  private async loadWarnings(errors: string[]) {
    try {
      const warnings = await this.warnings.getWarnings();
      await this.database.replaceActiveWarnings(warnings);
      return { values: warnings, unavailable: false };
    } catch (error) {
      const message = `Warnings: ${errorMessage(error)}`;
      errors.push(message);
      this.logger.warn({ error: message }, "Official warning request failed");
      return { values: [], unavailable: true };
    }
  }

  private async loadTides(now: Date, errors: string[]) {
    const end = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    let cached = await this.database.getTideExtremes(now, end);
    const coversNextDay = cached.some((item) => item.extremeAt.getTime() > now.getTime() + 24 * 60 * 60 * 1000);
    if (coversNextDay || !this.tides) return cached;
    try {
      const fetched = await this.tides.getExtremes(now, new Date(now.getTime() + 72 * 60 * 60 * 1000));
      await this.database.saveTideExtremes(fetched);
      cached = await this.database.getTideExtremes(now, end);
    } catch (error) {
      const message = `Tides: ${errorMessage(error)}`;
      errors.push(message);
      this.logger.warn({ error: message }, "Tide request failed");
    }
    return cached;
  }

  private async loadMarine(points: ControlPoint[], errors: string[]) {
    const settled = await Promise.allSettled(points.map((point) => this.marine.getSummary(point)));
    const values: MarinePointSummary[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") values.push(result.value);
      else {
        const point = points[index];
        const message = `Marine/${point?.id ?? "unknown"}: ${errorMessage(result.reason)}`;
        errors.push(message);
        this.logger.warn({ error: message }, "Marine forecast request failed");
      }
    }
    return { values, unavailable: values.length === 0 };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
