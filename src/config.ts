import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ControlPoint } from "./domain/types.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().optional().transform(emptyToUndefined),
  DATABASE_HOST: z.string().optional().transform(emptyToUndefined),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DATABASE_NAME: z.string().default("indra"),
  DATABASE_USER: z.string().default("indra"),
  DATABASE_PASSWORD: z.string().optional().transform(emptyToUndefined),
  TELEGRAM_BOT_TOKEN: z.string().optional().transform(emptyToUndefined),
  STORMGLASS_API_KEY: z.string().optional().transform(emptyToUndefined),
  APP_TIMEZONE: z.string().default("Europe/Moscow"),
  SCHEDULE_TIMES: z.string().default("05:00,11:00,17:00,23:00"),
  SCHEDULE_RETRY_MINUTES: z.coerce.number().int().positive().default(15),
  FRESH_FORECAST_MINUTES: z.coerce.number().int().positive().default(60),
  WEATHER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  WEATHER_RETRY_COUNT: z.coerce.number().int().min(0).max(5).default(2),
  WIND_CHANGE_THRESHOLD_MS: z.coerce.number().positive().default(2),
  WIND_AGREEMENT_THRESHOLD_MS: z.coerce.number().positive().default(2),
  GUST_AGREEMENT_THRESHOLD_MS: z.coerce.number().positive().default(3),
  DIRECTION_CHANGE_THRESHOLD_DEG: z.coerce.number().min(0).max(180).default(45),
  DIRECTION_AGREEMENT_THRESHOLD_DEG: z.coerce.number().min(0).max(180).default(45),
  EVENT_TIME_AGREEMENT_HOURS: z.coerce.number().positive().default(2),
  SATELLITE_ENABLED: z.enum(["true", "false"]).default("true")
    .transform((value) => value === "true"),
  SATELLITE_WMS_URL: z.url().default("https://view.eumetsat.int/geoserver/wms"),
  SATELLITE_WFS_URL: z.url().default("https://view.eumetsat.int/geoserver/wfs"),
  SATELLITE_BBOX: z.string().default("30,64,36,68"),
  SATELLITE_WIDTH: z.coerce.number().int().min(320).max(2000).default(1000),
  SATELLITE_HEIGHT: z.coerce.number().int().min(240).max(2000).default(800),
  SATELLITE_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(90),
  SATELLITE_CACHE_MINUTES: z.coerce.number().int().positive().default(10),
  SATELLITE_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(9_000_000),
});

const pointSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  order: z.number().int(),
  active: z.boolean(),
});

const schedulePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function emptyToUndefined(value: string | undefined): string | undefined {
  return value?.trim() === "" ? undefined : value;
}

function parseSchedule(value: string): string[] {
  const times = [...new Set(value.split(",").map((item) => item.trim()))];
  if (times.length === 0 || times.some((time) => !schedulePattern.test(time))) {
    throw new Error("SCHEDULE_TIMES must contain comma-separated HH:mm values");
  }
  return times.sort();
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid APP_TIMEZONE: ${timeZone}`);
  }
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  assertTimeZone(parsed.APP_TIMEZONE);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: resolveDatabaseUrl(parsed),
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    stormglassApiKey: parsed.STORMGLASS_API_KEY,
    timeZone: parsed.APP_TIMEZONE,
    scheduleTimes: parseSchedule(parsed.SCHEDULE_TIMES),
    scheduleRetryMinutes: parsed.SCHEDULE_RETRY_MINUTES,
    freshForecastMinutes: parsed.FRESH_FORECAST_MINUTES,
    weatherTimeoutMs: parsed.WEATHER_TIMEOUT_MS,
    weatherRetryCount: parsed.WEATHER_RETRY_COUNT,
    satellite: {
      enabled: parsed.SATELLITE_ENABLED,
      wmsUrl: parsed.SATELLITE_WMS_URL,
      wfsUrl: parsed.SATELLITE_WFS_URL,
      bbox: parseBoundingBox(parsed.SATELLITE_BBOX),
      width: parsed.SATELLITE_WIDTH,
      height: parsed.SATELLITE_HEIGHT,
      maxAgeMinutes: parsed.SATELLITE_MAX_AGE_MINUTES,
      cacheMinutes: parsed.SATELLITE_CACHE_MINUTES,
      maxImageBytes: parsed.SATELLITE_MAX_IMAGE_BYTES,
    },
    thresholds: {
      windChangeMs: parsed.WIND_CHANGE_THRESHOLD_MS,
      windAgreementMs: parsed.WIND_AGREEMENT_THRESHOLD_MS,
      gustAgreementMs: parsed.GUST_AGREEMENT_THRESHOLD_MS,
      directionChangeDeg: parsed.DIRECTION_CHANGE_THRESHOLD_DEG,
      directionAgreementDeg: parsed.DIRECTION_AGREEMENT_THRESHOLD_DEG,
      eventTimeAgreementHours: parsed.EVENT_TIME_AGREEMENT_HOURS,
    },
  };
}

function parseBoundingBox(value: string): [number, number, number, number] {
  const numbers = value.split(",").map((item) => Number(item.trim()));
  if (numbers.length !== 4 || numbers.some((item) => !Number.isFinite(item))) {
    throw new Error("SATELLITE_BBOX must contain west,south,east,north");
  }
  const [west, south, east, north] = numbers;
  if (west === undefined || south === undefined || east === undefined || north === undefined
    || west >= east || south >= north
    || west < -180 || east > 180 || south < -90 || north > 90) {
    throw new Error("SATELLITE_BBOX contains invalid coordinates");
  }
  return [west, south, east, north];
}

function resolveDatabaseUrl(parsed: z.infer<typeof envSchema>): string {
  if (parsed.DATABASE_HOST) {
    if (!parsed.DATABASE_PASSWORD) {
      throw new Error("DATABASE_PASSWORD is required when DATABASE_HOST is set");
    }
    const url = new URL("postgresql://placeholder");
    url.hostname = parsed.DATABASE_HOST;
    url.port = String(parsed.DATABASE_PORT);
    url.username = parsed.DATABASE_USER;
    url.password = parsed.DATABASE_PASSWORD;
    url.pathname = `/${parsed.DATABASE_NAME}`;
    return url.toString();
  }
  if (parsed.DATABASE_URL) return parsed.DATABASE_URL;
  throw new Error("Set DATABASE_URL or DATABASE_HOST with DATABASE_PASSWORD");
}

export async function loadControlPoints(
  path = resolve(process.cwd(), "config/points.json"),
): Promise<ControlPoint[]> {
  const content = await readFile(path, "utf8");
  const points = z.array(pointSchema).min(1).parse(JSON.parse(content));
  const ids = new Set(points.map((point) => point.id));
  if (ids.size !== points.length) throw new Error("Control point ids must be unique");
  return points.sort((left, right) => left.order - right.order);
}
