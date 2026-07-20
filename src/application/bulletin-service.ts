import { analyzeForecast } from "../domain/analysis.js";
import { renderBulletin } from "../domain/bulletin.js";
import type { BulletinRecord, Database } from "../infrastructure/database.js";
import type { OpenMeteoClient } from "../infrastructure/open-meteo.js";
import type { OpenMeteoMarineClient } from "../infrastructure/open-meteo-marine.js";
import type { StormglassClient } from "../infrastructure/stormglass.js";
import type { KolgimetClient } from "../infrastructure/kolgimet.js";
import type { AppConfig } from "../config.js";
import type {
  BulletinSummary,
  ControlPoint,
  ForecastValue,
  MarineForecastValue,
  MarinePointSummary,
  WeatherModel,
} from "../domain/types.js";
import type { Logger } from "../logger.js";
import { WEATHER_MODELS } from "../domain/types.js";
import { POINT_FORECAST_HOURS } from "../domain/point-forecast.js";
import { summarizeMarine } from "../infrastructure/open-meteo-marine.js";
import { summarizeWeatherCodes } from "../domain/weather-condition.js";

const TIDE_HISTORY_HOURS = 30;
const WEATHER_FALLBACK_CHUNK_SIZE = 3;
const WEATHER_FALLBACK_CONCURRENCY = 2;

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
    private readonly nextScheduledAt: (after?: Date) => Date | null,
  ) {}

  async getFreshOrRun(requiredForecastHours = 48, pointId?: string): Promise<BulletinRecord> {
    const latest = await this.database.getLatestBulletin();
    const freshnessMs = this.config.freshForecastMinutes * 60_000;
    if (latest?.contentFormat === "plain"
      && Date.now() - latest.createdAt.getTime() <= freshnessMs
      && await this.database.hasWeatherCodeCoverage(latest.runId, pointId)
      && (!pointId || await this.database.hasForecastCoverage(
        latest.runId,
        pointId,
        new Date(Date.now() + Math.max(0, requiredForecastHours - 2) * 60 * 60 * 1000),
      ))) return latest;
    const generated = await this.run({ kind: "manual" });
    if (generated) return generated;
    const fallback = await this.database.getLatestBulletin();
    if (!fallback) throw new Error("Collector is busy and no bulletin exists yet");
    return fallback;
  }

  async getStored(bulletinId: string): Promise<BulletinRecord | null> {
    return this.database.getBulletin(bulletinId);
  }

  async getScheduled(scheduledFor: Date): Promise<BulletinRecord | null> {
    return this.database.getScheduledBulletin(scheduledFor);
  }

  async run(options: RunBulletinOptions): Promise<BulletinRecord | null> {
    return this.database.withCollectorLock(async () => this.collect(options));
  }

  async createScheduledFallback(scheduledFor: Date): Promise<BulletinRecord> {
    const existing = await this.database.getScheduledBulletin(scheduledFor);
    if (existing) return existing;
    const latest = await this.database.getLatestBulletin();
    const dedupeKey = `scheduled:${scheduledFor.toISOString()}`;
    if (latest && latest.summary.pointSummaries.length > 0) {
      const generatedAt = new Date(latest.summary.generatedAt);
      const sourceCreatedAt = Number.isNaN(generatedAt.getTime()) ? latest.createdAt : generatedAt;
      return this.database.saveBulletin(
        latest.runId,
        "scheduled",
        dedupeKey,
        renderFallbackContent(
          latest.content,
          sourceCreatedAt,
          this.nextScheduledAt(scheduledFor),
          this.config.timeZone,
        ),
        latest.summary,
      );
    }

    const run = await this.database.createRun("scheduled", scheduledFor);
    const summary = unavailableSummary(scheduledFor);
    const bulletin = await this.database.saveBulletin(
      run.id,
      "scheduled",
      dedupeKey,
      renderUnavailableContent(
        scheduledFor,
        this.nextScheduledAt(scheduledFor),
        this.config.timeZone,
      ),
      summary,
    );
    await this.database.completeRun(run.id, "partial", "No weather data or previous bulletin available");
    return bulletin;
  }

  private async collect(options: RunBulletinOptions): Promise<BulletinRecord> {
    const startedAt = new Date();
    const run = await this.database.createRun(options.kind, options.scheduledFor ?? null);
    const errors: string[] = [];
    try {
      const activePoints = this.points.filter((point) => point.active);
      const weatherResult = await this.loadWeather(activePoints, startedAt, errors);
      const { values } = weatherResult;
      if (values.length === 0) {
        throw new Error("Both weather models are unavailable");
      }
      await this.database.saveForecastValues(run.id, values);

      const warningResult = await this.loadWarnings(errors);
      const tideValues = await this.loadTides(activePoints, startedAt, errors);
      const marineResult = await this.loadMarine(activePoints, startedAt, run.id, errors);
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
        const count = weatherResult.currentPoints[model] + weatherResult.fallbackPoints[model];
        const label = model.toUpperCase();
        if (count === 0) return [label];
        if (count < activePoints.length) {
          return [`${label} (${activePoints.length - count} точек без данных)`];
        }
        return [];
      });
      const fallbackModels = WEATHER_MODELS.flatMap((model) => {
        const count = weatherResult.fallbackPoints[model];
        return count > 0 ? [`${model.toUpperCase()} (${formatPointCount(count)})`] : [];
      });
      const content = renderBulletin({
        summary,
        warnings: warningResult.values,
        tides: tideValues,
        previousSummary,
        nextScheduledAt: this.nextScheduledAt(options.scheduledFor ?? startedAt),
        unavailableModels,
        fallbackModels,
        warningSourceUnavailable: warningResult.unavailable,
        marine: marineResult.values,
        marineSourceUnavailable: marineResult.unavailable,
        weather: summarizeWeatherCodes(values
          .filter((value) => value.forecastAt >= startedAt
            && value.forecastAt <= new Date(startedAt.getTime() + 24 * 60 * 60 * 1000))
          .map((value) => value.weatherCode)),
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
      await this.cleanupForecastData();
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

  private async loadWeather(
    points: ControlPoint[],
    now: Date,
    errors: string[],
  ): Promise<{
    values: ForecastValue[];
    currentPoints: Record<WeatherModel, number>;
    fallbackPoints: Record<WeatherModel, number>;
  }> {
    const values: ForecastValue[] = [];
    const currentPairs = new Set<string>();
    const fallbackPairs = new Set<string>();
    const primary = await Promise.allSettled(WEATHER_MODELS.map((model) =>
      this.weather.getForecasts(model, points, now, POINT_FORECAST_HOURS)));

    for (const [index, result] of primary.entries()) {
      const model = WEATHER_MODELS[index];
      if (!model) continue;
      if (result.status === "fulfilled") {
        addValidForecasts(values, currentPairs, result.value, model, points);
      } else {
        this.recordWeatherError(errors, `${model}/batch`, result.reason);
      }
    }

    const fallbackRequests = WEATHER_MODELS.flatMap((model) =>
      chunks(points.filter((point) => !currentPairs.has(pairKey(model, point.id))),
        WEATHER_FALLBACK_CHUNK_SIZE)
        .map((batch) => ({ model, points: batch })));
    const fallbackResults = await settleWithConcurrency(
      fallbackRequests,
      WEATHER_FALLBACK_CONCURRENCY,
      ({ model, points: batch }) =>
        this.weather.getForecasts(model, batch, now, POINT_FORECAST_HOURS),
    );
    for (const [index, result] of fallbackResults.entries()) {
      const request = fallbackRequests[index];
      if (!request) continue;
      if (result.status === "fulfilled") {
        addValidForecasts(values, currentPairs, result.value, request.model, request.points);
      } else {
        this.recordWeatherError(
          errors,
          `${request.model}/${request.points.map((point) => point.id).join(",")}`,
          result.reason,
        );
      }
    }

    const horizonEnd = new Date(now.getTime() + POINT_FORECAST_HOURS * 60 * 60 * 1000);
    const receivedAfter = new Date(
      now.getTime() - this.config.weatherFallbackMaxAgeHours * 60 * 60 * 1000,
    );
    const missing = WEATHER_MODELS.flatMap((model) => points
      .filter((point) => !currentPairs.has(pairKey(model, point.id)))
      .map((point) => ({ model, point })));
    const cached = await Promise.allSettled(missing.map(({ model, point }) =>
      this.database.getLatestForecastValues(point.id, model, now, horizonEnd, receivedAfter)));
    for (const [index, result] of cached.entries()) {
      const request = missing[index];
      if (!request || result.status !== "fulfilled") continue;
      const valid = result.value.filter((value) => value.windSpeedMs !== null);
      if (valid.length === 0) continue;
      values.push(...result.value);
      fallbackPairs.add(pairKey(request.model, request.point.id));
    }

    return {
      values,
      currentPoints: countPairs(currentPairs),
      fallbackPoints: countPairs(fallbackPairs),
    };
  }

  private recordWeatherError(errors: string[], request: string, reason: unknown): void {
    const message = `${request}: ${errorMessage(reason)}`;
    errors.push(message);
    this.logger.warn({ error: message }, "Weather request failed");
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

  private async cleanupForecastData(): Promise<void> {
    try {
      const removed = await this.database.removeExpiredForecastData(
        new Date(Date.now() - this.config.forecastDataRetentionDays * 86_400_000),
      );
      if (removed.forecasts > 0 || removed.marine > 0) {
        this.logger.info(removed, "Expired raw forecast data removed");
      }
    } catch (error) {
      this.logger.warn({ error }, "Expired forecast data cleanup failed");
    }
  }

  private async loadTides(points: ControlPoint[], now: Date, errors: string[]) {
    const start = new Date(now.getTime() - TIDE_HISTORY_HOURS * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const cachedByPoint = new Map(await Promise.all(points.map(async (point) => [
      point.id,
      await this.database.getTideExtremes(point.id, start, end),
    ] as const)));
    const stalePoints = points.filter((point) => {
      const cached = cachedByPoint.get(point.id) ?? [];
      return !coversNextTideDay(cached, now) || !hasEbbStart(cached, now);
    });
    const tides = this.tides;
    if (stalePoints.length === 0 || !tides) return [...cachedByPoint.values()].flat();

    const fetchEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const fetched = await Promise.allSettled(stalePoints.map((point) => tides.getExtremes(point, start, fetchEnd)));
    for (const [index, result] of fetched.entries()) {
      const point = stalePoints[index];
      if (!point) continue;
      if (result.status === "fulfilled") {
        await this.database.saveTideExtremes(result.value);
      } else {
        const message = `Tides/${point.id}: ${errorMessage(result.reason)}`;
        errors.push(message);
        this.logger.warn({ error: message }, "Tide request failed");
      }
    }
    return (await Promise.all(points.map((point) => this.database.getTideExtremes(point.id, start, end)))).flat();
  }

  private async loadMarine(
    points: ControlPoint[],
    now: Date,
    runId: string,
    errors: string[],
  ) {
    const settled = await Promise.allSettled(points.map((point) =>
      this.marine.getForecast(point, now, POINT_FORECAST_HOURS)));
    const values: MarinePointSummary[] = [];
    const forecasts: MarineForecastValue[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        const point = points[index];
        if (!point) continue;
        forecasts.push(...result.value);
        values.push(summarizeMarine(
          point,
          result.value.filter((value) => value.forecastAt <= new Date(now.getTime() + 24 * 60 * 60 * 1000)),
        ));
      } else {
        const point = points[index];
        const message = `Marine/${point?.id ?? "unknown"}: ${errorMessage(result.reason)}`;
        errors.push(message);
        this.logger.warn({ error: message }, "Marine forecast request failed");
      }
    }
    await this.database.saveMarineForecastValues(runId, forecasts);
    return { values, unavailable: values.length === 0 };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coversNextTideDay(tides: Array<{ extremeAt: Date }>, now: Date): boolean {
  return tides.some((item) => item.extremeAt.getTime() > now.getTime() + 24 * 60 * 60 * 1000);
}

function hasEbbStart(tides: Array<{ extremeAt: Date; type: "high" | "low" }>, now: Date): boolean {
  const next = [...tides]
    .sort((left, right) => left.extremeAt.getTime() - right.extremeAt.getTime())
    .find((item) => item.extremeAt > now);
  return next?.type !== "low" || tides.some((item) => item.type === "high" && item.extremeAt <= now);
}

function pairKey(model: WeatherModel, pointId: string): string {
  return `${model}:${pointId}`;
}

function addValidForecasts(
  target: ForecastValue[],
  pairs: Set<string>,
  forecasts: ForecastValue[],
  model: WeatherModel,
  points: ControlPoint[],
): void {
  for (const point of points) {
    const values = forecasts.filter((value) => value.pointId === point.id && value.model === model);
    if (!values.some((value) => value.windSpeedMs !== null)) continue;
    target.push(...values);
    pairs.add(pairKey(model, point.id));
  }
}

function countPairs(pairs: Set<string>): Record<WeatherModel, number> {
  const result: Record<WeatherModel, number> = { ecmwf: 0, gfs: 0 };
  for (const model of WEATHER_MODELS) {
    result[model] = [...pairs].filter((key) => key.startsWith(`${model}:`)).length;
  }
  return result;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function settleWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) continue;
      try {
        results[index] = { status: "fulfilled", value: await operation(value) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return results;
}

function formatPointCount(count: number): string {
  const modulo100 = count % 100;
  const modulo10 = count % 10;
  const noun = modulo100 >= 11 && modulo100 <= 14
    ? "точек"
    : modulo10 === 1
      ? "точка"
      : modulo10 >= 2 && modulo10 <= 4
        ? "точки"
        : "точек";
  return `${count} ${noun}`;
}

function unavailableSummary(generatedAt: Date): BulletinSummary {
  return {
    generatedAt: generatedAt.toISOString(),
    horizonHours: 0,
    directionChangeThresholdDeg: 0,
    directionAgreementThresholdDeg: 0,
    eventTimeAgreementHours: 0,
    pointSummaries: [],
    agreement: {
      agreed: false,
      windDifferenceMs: null,
      gustDifferenceMs: null,
      directionDifferenceDeg: null,
      eventTimeDifferenceHours: null,
      reasons: ["нет прогнозных данных"],
    },
    overallMaxWindMs: 0,
    overallMaxGustMs: null,
    outlook: { maxWindMs: null, maxGustMs: null },
  };
}

function renderFallbackContent(
  content: string,
  sourceCreatedAt: Date,
  nextScheduledAt: Date | null,
  timeZone: string,
): string {
  const lines = content.split("\n")
    .filter((line) => !line.startsWith("Резервный выпуск:"));
  const formedAt = lines.findIndex((line) => line.startsWith("Сформировано:"));
  lines.splice(formedAt >= 0 ? formedAt + 1 : 1, 0,
    "",
    `Резервный выпуск: обновить прогноз не удалось; используются данные от ${formatLocalDateTime(sourceCreatedAt, timeZone)}.`);
  const nextLine = lines.findIndex((line) => line.startsWith("Следующий выпуск:"));
  if (nextLine >= 0) {
    if (nextScheduledAt) {
      lines[nextLine] = `Следующий выпуск: ${formatLocalDateTime(nextScheduledAt, timeZone)}.`;
    } else {
      lines.splice(nextLine, 1);
    }
  }
  return lines.join("\n");
}

function renderUnavailableContent(
  scheduledFor: Date,
  nextScheduledAt: Date | null,
  timeZone: string,
): string {
  const lines = [
    "Кемь — Кандалакша · гидрометеосводка",
    `Сформировано: ${formatLocalDateTime(scheduledFor, timeZone)}`,
    "",
    "Прогнозные данные получить не удалось, предыдущего выпуска для резерва нет.",
    "Выпуск опубликован по расписанию; сбор продолжится при следующем запросе.",
  ];
  if (nextScheduledAt) {
    lines.push("", `Следующий выпуск: ${formatLocalDateTime(nextScheduledAt, timeZone)}.`);
  }
  return lines.join("\n");
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
