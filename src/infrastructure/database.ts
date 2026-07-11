import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import type {
  BulletinSummary,
  ControlPoint,
  ForecastValue,
  OfficialWarning,
  TideExtreme,
} from "../domain/types.js";

export interface BulletinRecord {
  id: string;
  content: string;
  summary: BulletinSummary;
  createdAt: Date;
}

export interface RunRecord {
  id: string;
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
            pressure_hpa, temperature_c
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      content: string;
      summary: unknown;
      created_at: Date;
    }>(`
      INSERT INTO bulletins (run_id, kind, dedupe_key, content, summary)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id, content, summary, created_at
    `, [runId, kind, dedupeKey, content, JSON.stringify(summary)]);
    const row = inserted.rows[0] ?? (await this.pool.query<{
      id: string;
      content: string;
      summary: unknown;
      created_at: Date;
    }>(`
      SELECT id, content, summary, created_at FROM bulletins WHERE dedupe_key = $1
    `, [dedupeKey])).rows[0];
    if (!row) throw new Error("Failed to save or load bulletin");
    return {
      id: row.id,
      content: row.content,
      summary: reviveSummary(row.summary),
      createdAt: row.created_at,
    };
  }

  async getLatestBulletin(): Promise<BulletinRecord | null> {
    const result = await this.pool.query<{
      id: string;
      content: string;
      summary: unknown;
      created_at: Date;
    }>(`
      SELECT id, content, summary, created_at
      FROM bulletins ORDER BY created_at DESC LIMIT 1
    `);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      content: row.content,
      summary: reviveSummary(row.summary),
      createdAt: row.created_at,
    } : null;
  }

  async getLastSuccessfulUpdate(): Promise<Date | null> {
    const result = await this.pool.query<{ completed_at: Date }>(`
      SELECT completed_at FROM collection_runs
      WHERE status IN ('succeeded', 'partial')
      ORDER BY completed_at DESC NULLS LAST LIMIT 1
    `);
    return result.rows[0]?.completed_at ?? null;
  }

  async subscribe(chatId: number): Promise<void> {
    await this.pool.query(`
      INSERT INTO subscribers (chat_id) VALUES ($1)
      ON CONFLICT (chat_id) DO UPDATE SET
        active = true, unsubscribed_at = NULL, updated_at = now()
    `, [chatId]);
  }

  async unsubscribe(chatId: number): Promise<void> {
    await this.pool.query(`
      UPDATE subscribers
      SET active = false, unsubscribed_at = now(), updated_at = now()
      WHERE chat_id = $1
    `, [chatId]);
  }

  async getActiveSubscriberIds(): Promise<number[]> {
    const result = await this.pool.query<{ chat_id: string }>(`
      SELECT chat_id FROM subscribers WHERE active = true ORDER BY chat_id
    `);
    return result.rows.map((row) => Number(row.chat_id));
  }

  async markDelivery(
    bulletinId: string,
    chatId: number,
    status: "sent" | "failed",
    messageId: number | null,
    error: string | null,
  ): Promise<void> {
    await this.pool.query(`
      INSERT INTO deliveries
        (bulletin_id, chat_id, status, attempts, telegram_message_id, last_error, sent_at)
      VALUES ($1, $2, $3, 1, $4, $5, CASE WHEN $3 = 'sent' THEN now() ELSE NULL END)
      ON CONFLICT (bulletin_id, chat_id) DO UPDATE SET
        status = EXCLUDED.status,
        telegram_message_id = EXCLUDED.telegram_message_id,
        last_error = EXCLUDED.last_error,
        sent_at = EXCLUDED.sent_at,
        updated_at = now()
    `, [bulletinId, chatId, status, messageId, error]);
  }

  async claimDelivery(bulletinId: string, chatId: number): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO deliveries (bulletin_id, chat_id, status, attempts)
      VALUES ($1, $2, 'pending', 1)
      ON CONFLICT (bulletin_id, chat_id) DO UPDATE SET
        status = 'pending', attempts = deliveries.attempts + 1, updated_at = now()
      WHERE deliveries.status = 'failed'
      RETURNING 1
    `, [bulletinId, chatId]);
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
