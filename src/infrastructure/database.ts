import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import type {
  BulletinSummary,
  ControlPoint,
  ForecastValue,
  MarineForecastValue,
  OfficialWarning,
  TideExtreme,
} from "../domain/types.js";

export interface BulletinRecord {
  id: string;
  runId: string;
  content: string;
  contentFormat: "plain" | "telegram_html";
  summary: BulletinSummary;
  createdAt: Date;
}

export interface RunRecord {
  id: string;
}

export interface MaxWebhookRecord {
  fingerprint: string;
  payload: unknown;
  attempts: number;
}

export interface SatelliteCaptureJobRecord {
  scheduledFor: Date;
  attempts: number;
}

export interface SatelliteAnimationFrameRecord {
  observedAt: Date;
  filename: string;
  byteSize: number;
  source: string;
}

export interface CloudAnimationFrameRecord extends SatelliteAnimationFrameRecord {
  mode: "cloudtype" | "fog";
}

export interface WindOverlayForecast {
  forecastAt: Date;
  points: Array<{
    pointId: string;
    name: string;
    latitude: number;
    longitude: number;
    model: "ecmwf" | "gfs";
    speedMs: number | null;
    directionDeg: number | null;
  }>;
}

export type StoredMapViewport = [west: number, south: number, east: number, north: number];

export type PersonalAnimationKind = "satellite" | "clouds";

export interface PersonalAnimationJobRecord {
  id: number;
  channel: string;
  recipientId: string;
  kind: PersonalAnimationKind;
  viewportKey: string;
  context: string;
  bbox: StoredMapViewport;
  width: number;
  height: number;
  attempts: number;
  outputFilename: string | null;
  source: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  frameCount: number | null;
}

interface PersonalAnimationJobRow {
  id: number;
  channel: string;
  recipient_id: string;
  kind: PersonalAnimationKind;
  viewport_key: string;
  animation_context: string;
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
  attempts: number;
  output_filename: string | null;
  source: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  frame_count: number | null;
}

export class Database {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async migrate(directory = resolve(process.cwd(), "migrations")): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await this.pool.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [file],
      );
      if (existing.rowCount) continue;
      const sql = await readFile(resolve(directory, file), "utf8");
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async syncControlPoints(points: ControlPoint[]): Promise<void> {
    for (const point of points) {
      await this.pool.query(`
        INSERT INTO control_points
          (id, name, latitude, longitude, display_order, active)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          display_order = EXCLUDED.display_order,
          active = EXCLUDED.active,
          updated_at = now()
      `, [point.id, point.name, point.latitude, point.longitude, point.order, point.active]);
    }
  }

  async createRun(kind: "scheduled" | "manual", scheduledFor: Date | null): Promise<RunRecord> {
    const result = await this.pool.query<{ id: string }>(`
      INSERT INTO collection_runs (kind, scheduled_for)
      VALUES ($1, $2)
      RETURNING id
    `, [kind, scheduledFor]);
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create collection run");
    return row;
  }

  async completeRun(
    runId: string,
    status: "succeeded" | "partial" | "failed",
    error: string | null = null,
  ): Promise<void> {
    await this.pool.query(`
      UPDATE collection_runs
      SET status = $2, error = $3, completed_at = now()
      WHERE id = $1
    `, [runId, status, error]);
  }

  async saveForecastValues(runId: string, values: ForecastValue[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const value of values) {
        await client.query(`
          INSERT INTO forecast_values (
            run_id, point_id, model, forecast_at, received_at,
            wind_speed_ms, wind_gust_ms, wind_direction_deg,
            precipitation_mm, precipitation_probability_pct, visibility_km,
            pressure_hpa, temperature_c, weather_code
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (run_id, point_id, model, forecast_at) DO NOTHING
        `, [
          runId,
          value.pointId,
          value.model,
          value.forecastAt,
          value.receivedAt,
          value.windSpeedMs,
          value.windGustMs,
          value.windDirectionDeg,
          value.precipitationMm,
          value.precipitationProbabilityPct,
          value.visibilityKm,
          value.pressureHpa,
          value.temperatureC,
          value.weatherCode,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveMarineForecastValues(runId: string, values: MarineForecastValue[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const value of values) {
        await client.query(`
          INSERT INTO marine_forecast_values (
            run_id, point_id, forecast_at, wave_height_m, wave_direction_deg,
            wave_period_seconds, wind_wave_height_m, swell_height_m,
            current_speed_kmh, current_direction_deg, sea_surface_temperature_c
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (run_id, point_id, forecast_at) DO NOTHING
        `, [
          runId,
          value.pointId,
          value.forecastAt,
          value.waveHeightM,
          value.waveDirectionDeg,
          value.wavePeriodSeconds,
          value.windWaveHeightM,
          value.swellHeightM,
          value.currentSpeedKmh,
          value.currentDirectionDeg,
          value.seaSurfaceTemperatureC,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceActiveWarnings(warnings: OfficialWarning[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE official_warnings SET active = false");
      for (const warning of warnings) {
        await client.query(`
          INSERT INTO official_warnings
            (fingerprint, source, source_url, raw_text, published_at, active)
          VALUES ($1, $2, $3, $4, $5, true)
          ON CONFLICT (fingerprint) DO UPDATE SET
            last_seen_at = now(), active = true
        `, [
          warning.fingerprint,
          warning.source,
          warning.sourceUrl,
          warning.rawText,
          warning.publishedAt,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getActiveWarnings(): Promise<OfficialWarning[]> {
    const result = await this.pool.query<{
      fingerprint: string;
      source: string;
      source_url: string;
      raw_text: string;
      published_at: Date | null;
    }>(`
      SELECT fingerprint, source, source_url, raw_text, published_at
      FROM official_warnings
      WHERE active = true
      ORDER BY published_at DESC NULLS LAST, first_seen_at DESC
    `);
    return result.rows.map((row) => ({
      fingerprint: row.fingerprint,
      source: row.source,
      sourceUrl: row.source_url,
      rawText: row.raw_text,
      publishedAt: row.published_at,
    }));
  }

  async saveTideExtremes(extremes: TideExtreme[]): Promise<void> {
    for (const item of extremes) {
      await this.pool.query(`
        INSERT INTO tide_extremes
          (extreme_at, type, height_m, source, station_name)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (source, extreme_at, type) DO UPDATE SET
          height_m = EXCLUDED.height_m,
          station_name = EXCLUDED.station_name,
          received_at = now()
      `, [item.extremeAt, item.type, item.heightM, item.source, item.stationName]);
    }
  }

  async getTideExtremes(start: Date, end: Date): Promise<TideExtreme[]> {
    const result = await this.pool.query<{
      extreme_at: Date;
      type: "high" | "low";
      height_m: number | null;
      source: string;
      station_name: string | null;
    }>(`
      SELECT extreme_at, type, height_m, source, station_name
      FROM tide_extremes
      WHERE extreme_at BETWEEN $1 AND $2
      ORDER BY extreme_at
    `, [start, end]);
    return result.rows.map((row) => ({
      extremeAt: row.extreme_at,
      type: row.type,
      heightM: row.height_m,
      source: row.source,
      stationName: row.station_name,
    }));
  }

  async getPreviousScheduledSummary(): Promise<BulletinSummary | null> {
    const result = await this.pool.query<{ summary: unknown }>(`
      SELECT summary FROM bulletins
      WHERE kind = 'scheduled'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return result.rows[0] ? reviveSummary(result.rows[0].summary) : null;
  }

  async saveBulletin(
    runId: string,
    kind: "scheduled" | "manual",
    dedupeKey: string,
    content: string,
    summary: BulletinSummary,
  ): Promise<BulletinRecord> {
    const inserted = await this.pool.query<{
      id: string;
      run_id: string;
      content: string;
      content_format: "plain" | "telegram_html";
      summary: unknown;
      created_at: Date;
    }>(`
      INSERT INTO bulletins (run_id, kind, dedupe_key, content, content_format, summary)
      VALUES ($1, $2, $3, $4, 'plain', $5::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id, run_id, content, content_format, summary, created_at
    `, [runId, kind, dedupeKey, content, JSON.stringify(summary)]);
    const row = inserted.rows[0] ?? (await this.pool.query<{
      id: string;
      run_id: string;
      content: string;
      content_format: "plain" | "telegram_html";
      summary: unknown;
      created_at: Date;
    }>(`
      SELECT id, run_id, content, content_format, summary, created_at
      FROM bulletins WHERE dedupe_key = $1
    `, [dedupeKey])).rows[0];
    if (!row) throw new Error("Failed to save or load bulletin");
    return {
      id: row.id,
      runId: row.run_id,
      content: row.content,
      contentFormat: row.content_format,
      summary: reviveSummary(row.summary),
      createdAt: row.created_at,
    };
  }

  async getLatestBulletin(): Promise<BulletinRecord | null> {
    const result = await this.pool.query<{
      id: string;
      run_id: string;
      content: string;
      content_format: "plain" | "telegram_html";
      summary: unknown;
      created_at: Date;
    }>(`
      SELECT id, run_id, content, content_format, summary, created_at
      FROM bulletins ORDER BY created_at DESC LIMIT 1
    `);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      runId: row.run_id,
      content: row.content,
      contentFormat: row.content_format,
      summary: reviveSummary(row.summary),
      createdAt: row.created_at,
    } : null;
  }

  async getForecastValues(runId: string, pointId: string): Promise<ForecastValue[]> {
    const result = await this.pool.query<{
      point_id: string;
      model: "ecmwf" | "gfs";
      forecast_at: Date;
      received_at: Date;
      wind_speed_ms: number | null;
      wind_gust_ms: number | null;
      wind_direction_deg: number | null;
      precipitation_mm: number | null;
      precipitation_probability_pct: number | null;
      weather_code: number | null;
      visibility_km: number | null;
      pressure_hpa: number | null;
      temperature_c: number | null;
    }>(`
      SELECT point_id, model, forecast_at, received_at, wind_speed_ms, wind_gust_ms,
             wind_direction_deg, precipitation_mm, precipitation_probability_pct,
             weather_code, visibility_km, pressure_hpa, temperature_c
      FROM forecast_values
      WHERE run_id = $1 AND point_id = $2
      ORDER BY forecast_at, model
    `, [runId, pointId]);
    return result.rows.map((row) => ({
      pointId: row.point_id,
      model: row.model,
      forecastAt: row.forecast_at,
      receivedAt: row.received_at,
      windSpeedMs: row.wind_speed_ms,
      windGustMs: row.wind_gust_ms,
      windDirectionDeg: row.wind_direction_deg,
      precipitationMm: row.precipitation_mm,
      precipitationProbabilityPct: row.precipitation_probability_pct,
      weatherCode: row.weather_code,
      visibilityKm: row.visibility_km,
      pressureHpa: row.pressure_hpa,
      temperatureC: row.temperature_c,
    }));
  }

  async hasForecastCoverage(runId: string, pointId: string, at: Date): Promise<boolean> {
    const result = await this.pool.query<{ available: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM forecast_values
        WHERE run_id = $1 AND point_id = $2 AND forecast_at >= $3
      ) AS available
    `, [runId, pointId, at]);
    return result.rows[0]?.available ?? false;
  }

  async hasWeatherCodeCoverage(runId: string, pointId?: string): Promise<boolean> {
    const result = await this.pool.query<{ available: boolean }>(`
      SELECT COALESCE(bool_and(weather_code IS NOT NULL), false) AS available
      FROM forecast_values
      WHERE run_id = $1 ${pointId ? "AND point_id = $2" : ""}
    `, pointId ? [runId, pointId] : [runId]);
    return result.rows[0]?.available ?? false;
  }

  async getMarineForecastValues(runId: string, pointId: string): Promise<MarineForecastValue[]> {
    const result = await this.pool.query<{
      point_id: string;
      forecast_at: Date;
      wave_height_m: number | null;
      wave_direction_deg: number | null;
      wave_period_seconds: number | null;
      wind_wave_height_m: number | null;
      swell_height_m: number | null;
      current_speed_kmh: number | null;
      current_direction_deg: number | null;
      sea_surface_temperature_c: number | null;
    }>(`
      SELECT point_id, forecast_at, wave_height_m, wave_direction_deg,
             wave_period_seconds, wind_wave_height_m, swell_height_m,
             current_speed_kmh, current_direction_deg, sea_surface_temperature_c
      FROM marine_forecast_values
      WHERE run_id = $1 AND point_id = $2
      ORDER BY forecast_at
    `, [runId, pointId]);
    return result.rows.map((row) => ({
      pointId: row.point_id,
      forecastAt: row.forecast_at,
      waveHeightM: row.wave_height_m,
      waveDirectionDeg: row.wave_direction_deg,
      wavePeriodSeconds: row.wave_period_seconds,
      windWaveHeightM: row.wind_wave_height_m,
      swellHeightM: row.swell_height_m,
      currentSpeedKmh: row.current_speed_kmh,
      currentDirectionDeg: row.current_direction_deg,
      seaSurfaceTemperatureC: row.sea_surface_temperature_c,
    }));
  }

  async getLastSuccessfulUpdate(): Promise<Date | null> {
    const result = await this.pool.query<{ completed_at: Date }>(`
      SELECT completed_at FROM collection_runs
      WHERE status IN ('succeeded', 'partial')
      ORDER BY completed_at DESC NULLS LAST LIMIT 1
    `);
    return result.rows[0]?.completed_at ?? null;
  }

  async subscribe(channel: string, recipientId: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO delivery_subscriptions (channel, recipient_id) VALUES ($1, $2)
      ON CONFLICT (channel, recipient_id) DO UPDATE SET
        active = true, unsubscribed_at = NULL, updated_at = now()
    `, [channel, recipientId]);
  }

  async unsubscribe(channel: string, recipientId: string): Promise<void> {
    await this.pool.query(`
      UPDATE delivery_subscriptions
      SET active = false, unsubscribed_at = now(), updated_at = now()
      WHERE channel = $1 AND recipient_id = $2
    `, [channel, recipientId]);
  }

  async getActiveRecipientIds(channel: string): Promise<string[]> {
    const result = await this.pool.query<{ recipient_id: string }>(`
      SELECT recipient_id FROM delivery_subscriptions
      WHERE channel = $1 AND active = true
      ORDER BY recipient_id
    `, [channel]);
    return result.rows.map((row) => row.recipient_id);
  }

  async getMapViewport(channel: string, recipientId: string): Promise<StoredMapViewport | null> {
    const result = await this.pool.query<{
      west: number;
      south: number;
      east: number;
      north: number;
    }>(`
      SELECT west, south, east, north
      FROM map_viewports
      WHERE channel = $1 AND recipient_id = $2
    `, [channel, recipientId]);
    const row = result.rows[0];
    return row ? [row.west, row.south, row.east, row.north] : null;
  }

  async saveMapViewport(
    channel: string,
    recipientId: string,
    [west, south, east, north]: StoredMapViewport,
  ): Promise<void> {
    await this.pool.query(`
      INSERT INTO map_viewports (channel, recipient_id, west, south, east, north)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (channel, recipient_id) DO UPDATE SET
        west = EXCLUDED.west,
        south = EXCLUDED.south,
        east = EXCLUDED.east,
        north = EXCLUDED.north,
        updated_at = now()
    `, [channel, recipientId, west, south, east, north]);
  }

  async getCachedPersonalAnimation(
    channel: string,
    recipientId: string,
    kind: PersonalAnimationKind,
    viewportKey: string,
    context: string,
    since: Date,
  ): Promise<PersonalAnimationJobRecord | null> {
    const result = await this.pool.query<PersonalAnimationJobRow>(`
      SELECT id, channel, recipient_id, kind, viewport_key, animation_context, west, south, east, north,
             width, height, attempts, output_filename, source, started_at, ended_at, frame_count
      FROM personal_animation_jobs
      WHERE channel = $1 AND recipient_id = $2 AND kind = $3 AND viewport_key = $4
        AND animation_context = $5
        AND status = 'completed' AND processed_at >= $6 AND output_filename IS NOT NULL
      ORDER BY processed_at DESC
      LIMIT 1
    `, [channel, recipientId, kind, viewportKey, context, since]);
    return personalAnimationJob(result.rows[0]);
  }

  async enqueuePersonalAnimation(
    channel: string,
    recipientId: string,
    kind: PersonalAnimationKind,
    viewportKey: string,
    context: string,
    bbox: StoredMapViewport,
    width: number,
    height: number,
  ): Promise<PersonalAnimationJobRecord> {
    await this.pool.query(`
      UPDATE personal_animation_jobs
      SET status = 'cancelled', updated_at = now()
      WHERE channel = $1 AND recipient_id = $2 AND kind = $3
        AND status = 'pending' AND (viewport_key <> $4 OR animation_context <> $5)
    `, [channel, recipientId, kind, viewportKey, context]);
    const [west, south, east, north] = bbox;
    const inserted = await this.pool.query<PersonalAnimationJobRow>(`
      INSERT INTO personal_animation_jobs
        (channel, recipient_id, kind, viewport_key, animation_context, west, south, east, north, width, height)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT DO NOTHING
      RETURNING id, channel, recipient_id, kind, viewport_key, animation_context, west, south, east, north,
                width, height, attempts, output_filename, source, started_at, ended_at, frame_count
    `, [channel, recipientId, kind, viewportKey, context, west, south, east, north, width, height]);
    const row = inserted.rows[0] ?? (await this.pool.query<PersonalAnimationJobRow>(`
      SELECT id, channel, recipient_id, kind, viewport_key, animation_context, west, south, east, north,
             width, height, attempts, output_filename, source, started_at, ended_at, frame_count
      FROM personal_animation_jobs
      WHERE channel = $1 AND recipient_id = $2 AND kind = $3 AND viewport_key = $4
        AND animation_context = $5
        AND status IN ('pending', 'processing')
      ORDER BY created_at DESC
      LIMIT 1
    `, [channel, recipientId, kind, viewportKey, context])).rows[0];
    const job = personalAnimationJob(row);
    if (!job) throw new Error("Failed to enqueue personal animation");
    return job;
  }

  async resetProcessingPersonalAnimations(): Promise<void> {
    await this.pool.query(`
      UPDATE personal_animation_jobs
      SET status = 'pending', next_attempt_at = now(), updated_at = now()
      WHERE status = 'processing'
    `);
  }

  async claimPersonalAnimation(): Promise<PersonalAnimationJobRecord | null> {
    const result = await this.pool.query<PersonalAnimationJobRow>(`
      WITH candidate AS (
        SELECT id
        FROM personal_animation_jobs
        WHERE status IN ('pending', 'failed')
          AND attempts < 3
          AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE personal_animation_jobs AS job
      SET status = 'processing', attempts = attempts + 1, updated_at = now()
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.id, job.channel, job.recipient_id, job.kind, job.viewport_key, job.animation_context,
                job.west, job.south, job.east, job.north, job.width, job.height,
                job.attempts, job.output_filename, job.source, job.started_at, job.ended_at,
                job.frame_count
    `);
    return personalAnimationJob(result.rows[0]);
  }

  async completePersonalAnimation(
    jobId: number,
    outputFilename: string,
    source: string,
    startedAt: Date,
    endedAt: Date,
    frameCount: number,
  ): Promise<void> {
    await this.pool.query(`
      UPDATE personal_animation_jobs
      SET status = 'completed', output_filename = $2, source = $3,
          started_at = $4, ended_at = $5, frame_count = $6,
          processed_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $1
    `, [jobId, outputFilename, source, startedAt, endedAt, frameCount]);
  }

  async failPersonalAnimation(jobId: number, error: string, attempts: number): Promise<void> {
    const retrySeconds = Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
    await this.pool.query(`
      UPDATE personal_animation_jobs
      SET status = 'failed', last_error = $2,
          next_attempt_at = now() + ($3::integer * interval '1 second'), updated_at = now()
      WHERE id = $1
    `, [jobId, error.slice(0, 2000), retrySeconds]);
  }

  async cancelPersonalAnimation(jobId: number): Promise<void> {
    await this.pool.query(`
      UPDATE personal_animation_jobs
      SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'processing')
    `, [jobId]);
  }

  async isMapViewportCurrent(
    channel: string,
    recipientId: string,
    [west, south, east, north]: StoredMapViewport,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      SELECT 1
      FROM map_viewports
      WHERE channel = $1 AND recipient_id = $2
        AND west = $3 AND south = $4 AND east = $5 AND north = $6
    `, [channel, recipientId, west, south, east, north]);
    return Boolean(result.rowCount);
  }

  async removeExpiredPersonalAnimations(before: Date): Promise<string[]> {
    const result = await this.pool.query<{ output_filename: string | null }>(`
      DELETE FROM personal_animation_jobs
      WHERE created_at < $1 AND status IN ('completed', 'failed', 'cancelled')
      RETURNING output_filename
    `, [before]);
    return result.rows.flatMap((row) => row.output_filename ? [row.output_filename] : []);
  }

  async enqueueMaxWebhook(fingerprint: string, payload: unknown): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO max_webhook_events (fingerprint, payload)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (fingerprint) DO NOTHING
      RETURNING 1
    `, [fingerprint, JSON.stringify(payload)]);
    return Boolean(result.rowCount);
  }

  async resetProcessingMaxWebhooks(): Promise<void> {
    await this.pool.query(`
      UPDATE max_webhook_events
      SET status = 'pending', next_attempt_at = now(), updated_at = now()
      WHERE status = 'processing'
    `);
  }

  async claimMaxWebhook(): Promise<MaxWebhookRecord | null> {
    const result = await this.pool.query<{
      fingerprint: string;
      payload: unknown;
      attempts: number;
    }>(`
      WITH candidate AS (
        SELECT fingerprint
        FROM max_webhook_events
        WHERE status IN ('pending', 'failed')
          AND attempts < 5
          AND next_attempt_at <= now()
        ORDER BY received_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE max_webhook_events AS event
      SET status = 'processing', attempts = attempts + 1, updated_at = now()
      FROM candidate
      WHERE event.fingerprint = candidate.fingerprint
      RETURNING event.fingerprint, event.payload, event.attempts
    `);
    return result.rows[0] ?? null;
  }

  async completeMaxWebhook(fingerprint: string): Promise<void> {
    await this.pool.query(`
      UPDATE max_webhook_events
      SET status = 'processed', processed_at = now(), last_error = NULL, updated_at = now()
      WHERE fingerprint = $1
    `, [fingerprint]);
  }

  async failMaxWebhook(fingerprint: string, error: string, attempts: number): Promise<void> {
    const retrySeconds = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
    await this.pool.query(`
      UPDATE max_webhook_events
      SET status = 'failed', last_error = $2,
          next_attempt_at = now() + ($3::integer * interval '1 second'), updated_at = now()
      WHERE fingerprint = $1
    `, [fingerprint, error.slice(0, 2000), retrySeconds]);
  }

  async enqueueSatelliteCaptureJob(scheduledFor: Date): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO satellite_capture_jobs (scheduled_for)
      VALUES ($1)
      ON CONFLICT (scheduled_for) DO NOTHING
      RETURNING 1
    `, [scheduledFor]);
    return Boolean(result.rowCount);
  }

  async resetProcessingSatelliteCaptureJobs(): Promise<void> {
    await this.pool.query(`
      UPDATE satellite_capture_jobs
      SET status = 'pending', next_attempt_at = now(), updated_at = now()
      WHERE status = 'processing'
    `);
  }

  async claimSatelliteCaptureJob(): Promise<SatelliteCaptureJobRecord | null> {
    const result = await this.pool.query<{
      scheduled_for: Date;
      attempts: number;
    }>(`
      WITH candidate AS (
        SELECT scheduled_for
        FROM satellite_capture_jobs
        WHERE status IN ('pending', 'failed')
          AND attempts < 5
          AND next_attempt_at <= now()
        ORDER BY scheduled_for
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE satellite_capture_jobs AS job
      SET status = 'processing', attempts = attempts + 1, updated_at = now()
      FROM candidate
      WHERE job.scheduled_for = candidate.scheduled_for
      RETURNING job.scheduled_for, job.attempts
    `);
    const row = result.rows[0];
    return row ? { scheduledFor: row.scheduled_for, attempts: row.attempts } : null;
  }

  async completeSatelliteCaptureJob(scheduledFor: Date): Promise<void> {
    await this.pool.query(`
      UPDATE satellite_capture_jobs
      SET status = 'processed', processed_at = now(), last_error = NULL, updated_at = now()
      WHERE scheduled_for = $1
    `, [scheduledFor]);
  }

  async failSatelliteCaptureJob(scheduledFor: Date, error: string, attempts: number): Promise<void> {
    const retrySeconds = Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
    await this.pool.query(`
      UPDATE satellite_capture_jobs
      SET status = 'failed', last_error = $2,
          next_attempt_at = now() + ($3::integer * interval '1 second'), updated_at = now()
      WHERE scheduled_for = $1
    `, [scheduledFor, error.slice(0, 2000), retrySeconds]);
  }

  async saveSatelliteAnimationFrame(
    observedAt: Date,
    filename: string,
    byteSize: number,
    source: string,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO satellite_animation_frames (observed_at, filename, byte_size, source)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (observed_at) DO NOTHING
      RETURNING 1
    `, [observedAt, filename, byteSize, source]);
    return Boolean(result.rowCount);
  }

  async getSatelliteAnimationFrames(since: Date): Promise<SatelliteAnimationFrameRecord[]> {
    const result = await this.pool.query<{
      observed_at: Date;
      filename: string;
      byte_size: number;
      source: string;
    }>(`
      SELECT observed_at, filename, byte_size, source
      FROM satellite_animation_frames
      WHERE observed_at >= $1
      ORDER BY observed_at
    `, [since]);
    return result.rows.map((row) => ({
      observedAt: row.observed_at,
      filename: row.filename,
      byteSize: row.byte_size,
      source: row.source,
    }));
  }

  async removeExpiredSatelliteAnimationFrames(before: Date): Promise<string[]> {
    const result = await this.pool.query<{ filename: string }>(`
      DELETE FROM satellite_animation_frames
      WHERE observed_at < $1
      RETURNING filename
    `, [before]);
    return result.rows.map((row) => row.filename);
  }

  async removeExpiredSatelliteCaptureJobs(before: Date): Promise<void> {
    await this.pool.query(`
      DELETE FROM satellite_capture_jobs
      WHERE scheduled_for < $1 AND status IN ('processed', 'failed')
    `, [before]);
  }

  async enqueueCloudAnimationCaptureJob(scheduledFor: Date): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO cloud_animation_capture_jobs (scheduled_for)
      VALUES ($1)
      ON CONFLICT (scheduled_for) DO NOTHING
      RETURNING 1
    `, [scheduledFor]);
    return Boolean(result.rowCount);
  }

  async resetProcessingCloudAnimationCaptureJobs(): Promise<void> {
    await this.pool.query(`
      UPDATE cloud_animation_capture_jobs
      SET status = 'pending', next_attempt_at = now(), updated_at = now()
      WHERE status = 'processing'
    `);
  }

  async claimCloudAnimationCaptureJob(): Promise<SatelliteCaptureJobRecord | null> {
    const result = await this.pool.query<{
      scheduled_for: Date;
      attempts: number;
    }>(`
      WITH candidate AS (
        SELECT scheduled_for
        FROM cloud_animation_capture_jobs
        WHERE status IN ('pending', 'failed')
          AND attempts < 5
          AND next_attempt_at <= now()
        ORDER BY scheduled_for
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE cloud_animation_capture_jobs AS job
      SET status = 'processing', attempts = attempts + 1, updated_at = now()
      FROM candidate
      WHERE job.scheduled_for = candidate.scheduled_for
      RETURNING job.scheduled_for, job.attempts
    `);
    const row = result.rows[0];
    return row ? { scheduledFor: row.scheduled_for, attempts: row.attempts } : null;
  }

  async completeCloudAnimationCaptureJob(scheduledFor: Date): Promise<void> {
    await this.pool.query(`
      UPDATE cloud_animation_capture_jobs
      SET status = 'processed', processed_at = now(), last_error = NULL, updated_at = now()
      WHERE scheduled_for = $1
    `, [scheduledFor]);
  }

  async failCloudAnimationCaptureJob(scheduledFor: Date, error: string, attempts: number): Promise<void> {
    const retrySeconds = Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
    await this.pool.query(`
      UPDATE cloud_animation_capture_jobs
      SET status = 'failed', last_error = $2,
          next_attempt_at = now() + ($3::integer * interval '1 second'), updated_at = now()
      WHERE scheduled_for = $1
    `, [scheduledFor, error.slice(0, 2000), retrySeconds]);
  }

  async saveCloudAnimationFrame(
    observedAt: Date,
    mode: "cloudtype" | "fog",
    filename: string,
    byteSize: number,
    source: string,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO cloud_animation_frames (mode, observed_at, filename, byte_size, source)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (mode, observed_at) DO NOTHING
      RETURNING 1
    `, [mode, observedAt, filename, byteSize, source]);
    return Boolean(result.rowCount);
  }

  async getCloudAnimationFrames(
    since: Date,
    mode: "cloudtype" | "fog",
  ): Promise<CloudAnimationFrameRecord[]> {
    const result = await this.pool.query<{
      mode: "cloudtype" | "fog";
      observed_at: Date;
      filename: string;
      byte_size: number;
      source: string;
    }>(`
      SELECT mode, observed_at, filename, byte_size, source
      FROM cloud_animation_frames
      WHERE observed_at >= $1 AND mode = $2
      ORDER BY observed_at
    `, [since, mode]);
    return result.rows.map((row) => ({
      mode: row.mode,
      observedAt: row.observed_at,
      filename: row.filename,
      byteSize: row.byte_size,
      source: row.source,
    }));
  }

  async removeExpiredCloudAnimationFrames(before: Date): Promise<string[]> {
    const result = await this.pool.query<{ filename: string }>(`
      DELETE FROM cloud_animation_frames
      WHERE observed_at < $1
      RETURNING filename
    `, [before]);
    return result.rows.map((row) => row.filename);
  }

  async removeExpiredCloudAnimationCaptureJobs(before: Date): Promise<void> {
    await this.pool.query(`
      DELETE FROM cloud_animation_capture_jobs
      WHERE scheduled_for < $1 AND status IN ('processed', 'failed')
    `, [before]);
  }

  async getLatestWindOverlay(referenceAt: Date): Promise<WindOverlayForecast | null> {
    const result = await this.pool.query<{
      forecast_at: Date;
      point_id: string;
      name: string;
      latitude: number;
      longitude: number;
      model: "ecmwf" | "gfs";
      wind_speed_ms: number | null;
      wind_direction_deg: number | null;
    }>(`
      WITH latest_run AS (
        SELECT id
        FROM collection_runs
        WHERE status IN ('succeeded', 'partial')
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 1
      ), target AS (
        SELECT forecast_at
        FROM forecast_values
        WHERE run_id = (SELECT id FROM latest_run)
          AND wind_speed_ms IS NOT NULL
          AND wind_direction_deg IS NOT NULL
        ORDER BY ABS(EXTRACT(EPOCH FROM (forecast_at - $1)))
        LIMIT 1
      )
      SELECT forecast_at, point_id, name, latitude, longitude, model,
             wind_speed_ms, wind_direction_deg
      FROM forecast_values
      JOIN control_points ON control_points.id = forecast_values.point_id
      WHERE run_id = (SELECT id FROM latest_run)
        AND forecast_at = (SELECT forecast_at FROM target)
        AND control_points.active = true
      ORDER BY control_points.display_order, model
    `, [referenceAt]);
    const first = result.rows[0];
    if (!first) return null;
    return {
      forecastAt: first.forecast_at,
      points: result.rows.map((row) => ({
        pointId: row.point_id,
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
        model: row.model,
        speedMs: row.wind_speed_ms,
        directionDeg: row.wind_direction_deg,
      })),
    };
  }

  async markDelivery(
    bulletinId: string,
    channel: string,
    recipientId: string,
    status: "sent" | "failed",
    externalMessageId: string | null,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(`
      INSERT INTO deliveries
        (bulletin_id, channel, recipient_id, status, attempts,
         external_message_id, last_error, sent_at)
      VALUES ($1, $2, $3, $4, 1, $5, $6,
        CASE WHEN $4 = 'sent' THEN now() ELSE NULL END)
      ON CONFLICT (bulletin_id, channel, recipient_id) DO UPDATE SET
        status = EXCLUDED.status,
        external_message_id = EXCLUDED.external_message_id,
        last_error = EXCLUDED.last_error,
        sent_at = EXCLUDED.sent_at,
        updated_at = now()
    `, [bulletinId, channel, recipientId, status, externalMessageId, error]);
  }

  async claimDelivery(
    bulletinId: string,
    channel: string,
    recipientId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO deliveries (bulletin_id, channel, recipient_id, status, attempts)
      VALUES ($1, $2, $3, 'pending', 1)
      ON CONFLICT (bulletin_id, channel, recipient_id) DO UPDATE SET
        status = 'pending', attempts = deliveries.attempts + 1, updated_at = now()
      WHERE deliveries.status = 'failed'
      RETURNING 1
    `, [bulletinId, channel, recipientId]);
    return Boolean(result.rowCount);
  }

  async withCollectorLock<T>(operation: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(824_071_421) AS acquired",
      );
      if (!lock.rows[0]?.acquired) return null;
      try {
        return await operation();
      } finally {
        await client.query("SELECT pg_advisory_unlock(824_071_421)");
      }
    } finally {
      client.release();
    }
  }
}

function reviveSummary(raw: unknown): BulletinSummary {
  const summary = raw as BulletinSummary;
  for (const point of summary.pointSummaries) {
    for (const model of Object.values(point.models)) {
      if (model?.windChangeAt && !(model.windChangeAt instanceof Date)) {
        model.windChangeAt = new Date(model.windChangeAt);
      }
    }
  }
  return summary;
}

function personalAnimationJob(row: PersonalAnimationJobRow | undefined): PersonalAnimationJobRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    recipientId: row.recipient_id,
    kind: row.kind,
    viewportKey: row.viewport_key,
    context: row.animation_context,
    bbox: [row.west, row.south, row.east, row.north],
    width: row.width,
    height: row.height,
    attempts: row.attempts,
    outputFilename: row.output_filename,
    source: row.source,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    frameCount: row.frame_count,
  };
}
