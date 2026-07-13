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
  MAX_BOT_TOKEN: z.string().optional().transform(emptyToUndefined),
  MAX_PUBLIC_BASE_URL: z.string().optional().transform(emptyToUndefined),
  STORMGLASS_API_KEY: z.string().optional().transform(emptyToUndefined),
  COPERNICUS_CLIENT_ID: z.string().optional().transform(emptyToUndefined),
  COPERNICUS_CLIENT_SECRET: z.string().optional().transform(emptyToUndefined),
  EUMETSAT_CONSUMER_KEY: z.string().optional().transform(emptyToUndefined),
  EUMETSAT_CONSUMER_SECRET: z.string().optional().transform(emptyToUndefined),
  APP_TIMEZONE: z.string().default("Europe/Moscow"),
  SCHEDULE_TIMES: z.string().default("05:00,11:00,17:00,23:00"),
  SCHEDULE_RETRY_MINUTES: z.coerce.number().int().positive().default(15),
  SCHEDULE_RECOVERY_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  FRESH_FORECAST_MINUTES: z.coerce.number().int().positive().default(60),
  DELIVERY_RETRY_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  DELIVERY_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  FORECAST_DATA_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  UPDATE_TELEGRAM_RECIPIENT_IDS: z.string().default(""),
  UPDATE_MAX_RECIPIENT_IDS: z.string().default(""),
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
  IMAGE_CACHE_MAX_ENTRIES: z.coerce.number().int().min(4).max(64).default(16),
  SATELLITE_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(9_000_000),
  SATELLITE_ANIMATION_ENABLED: z.enum(["true", "false"]).default("true")
    .transform((value) => value === "true"),
  SATELLITE_ANIMATION_INTERVAL_MINUTES: z.coerce.number().int().min(10).max(60).default(20),
  SATELLITE_ANIMATION_WINDOW_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  SATELLITE_ANIMATION_RETENTION_HOURS: z.coerce.number().int().min(24).max(72).default(26),
  SATELLITE_ANIMATION_MIN_FRAMES: z.coerce.number().int().min(3).max(72).default(3),
  SATELLITE_ANIMATION_DIRECTORY: z.string().default("/var/lib/indra/satellite-animation"),
  SATELLITE_ANIMATION_MAX_BYTES: z.coerce.number().int().positive().default(15_000_000),
  CLOUD_ANIMATION_ENABLED: z.enum(["true", "false"]).default("true")
    .transform((value) => value === "true"),
  CLOUD_ANIMATION_DIRECTORY: z.string().default("/var/lib/indra/cloud-animation"),
  CLOUD_DIAGNOSTIC_CACHE_MINUTES: z.coerce.number().int().positive().default(10),
  PERSONAL_ANIMATION_ENABLED: z.enum(["true", "false"]).default("true")
    .transform((value) => value === "true"),
  PERSONAL_ANIMATION_DIRECTORY: z.string().default("/var/lib/indra/personal-animation"),
  PERSONAL_ANIMATION_CACHE_MINUTES: z.coerce.number().int().min(1).max(120).default(20),
  DETAILED_SATELLITE_ENABLED: z.enum(["true", "false"]).default("true")
    .transform((value) => value === "true"),
  DETAILED_SATELLITE_BBOX: z.string().default("31.4,65.6,35.8,67.4"),
  DETAILED_SATELLITE_WIDTH: z.coerce.number().int().min(320).max(2000).default(1000),
  DETAILED_SATELLITE_HEIGHT: z.coerce.number().int().min(240).max(2000).default(1000),
  DETAILED_SATELLITE_MAX_AGE_HOURS: z.coerce.number().positive().default(12),
  DETAILED_SATELLITE_MIN_COVERAGE_PERCENT: z.coerce.number().min(1).max(100).default(20),
  DETAILED_SATELLITE_PREFERRED_COVERAGE_PERCENT: z.coerce.number().min(1).max(100).default(70),
  DETAILED_SATELLITE_CACHE_MINUTES: z.coerce.number().int().positive().default(30),
  DETAILED_SATELLITE_PASS_RADIUS_KM: z.coerce.number().positive().default(450),
  EUMETSAT_CATALOG_URL: z.url()
    .default("https://api.eumetsat.int/data/search-products/1.0.0/os"),
  EUMETSAT_SENTINEL_COLLECTION_ID: z.string().default("EO:EUM:DAT:0409"),
  EUMETSAT_TLE_S3A_URL: z.url()
    .default("https://service.eumetsat.int/tle/javascript/data_content_s3a.js"),
  EUMETSAT_TLE_S3B_URL: z.url()
    .default("https://service.eumetsat.int/tle/javascript/data_content_s3b.js"),
  LIGHTNING_WINDOW_MINUTES: z.coerce.number().int().min(10).max(120).default(30),
  LIGHTNING_CACHE_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  LIGHTNING_MAX_PRODUCT_BYTES: z.coerce.number().int().positive().max(200_000_000).default(60_000_000),
  COPERNICUS_RADAR_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  RADAR_CACHE_MINUTES: z.coerce.number().int().positive().default(30),
});

const pointSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  shortName: z.string().min(1),
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

function parseRecipientIds(value: string, name: string): string[] {
  const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (ids.some((id) => !/^[1-9]\d*$/u.test(id))) {
    throw new Error(`${name} must contain comma-separated positive numeric IDs`);
  }
  return [...new Set(ids)];
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
  if (parsed.DETAILED_SATELLITE_PREFERRED_COVERAGE_PERCENT
    < parsed.DETAILED_SATELLITE_MIN_COVERAGE_PERCENT) {
    throw new Error("DETAILED_SATELLITE_PREFERRED_COVERAGE_PERCENT must not be below the minimum");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: resolveDatabaseUrl(parsed),
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    max: resolveMaxConfig(parsed.MAX_BOT_TOKEN, parsed.MAX_PUBLIC_BASE_URL),
    stormglassApiKey: parsed.STORMGLASS_API_KEY,
    copernicus: resolveCopernicusConfig(parsed.COPERNICUS_CLIENT_ID, parsed.COPERNICUS_CLIENT_SECRET, parsed.COPERNICUS_RADAR_LOOKBACK_DAYS),
    lightning: resolveEumetsatLightningConfig(
      parsed.EUMETSAT_CONSUMER_KEY,
      parsed.EUMETSAT_CONSUMER_SECRET,
      parsed.LIGHTNING_WINDOW_MINUTES,
      parsed.LIGHTNING_CACHE_MINUTES,
      parsed.LIGHTNING_MAX_PRODUCT_BYTES,
    ),
    radarCacheMinutes: parsed.RADAR_CACHE_MINUTES,
    timeZone: parsed.APP_TIMEZONE,
    scheduleTimes: parseSchedule(parsed.SCHEDULE_TIMES),
    scheduleRetryMinutes: parsed.SCHEDULE_RETRY_MINUTES,
    scheduleRecoveryHours: parsed.SCHEDULE_RECOVERY_HOURS,
    freshForecastMinutes: parsed.FRESH_FORECAST_MINUTES,
    deliveryRetry: {
      intervalSeconds: parsed.DELIVERY_RETRY_INTERVAL_SECONDS,
      maxAttempts: parsed.DELIVERY_RETRY_MAX_ATTEMPTS,
    },
    forecastDataRetentionDays: parsed.FORECAST_DATA_RETENTION_DAYS,
    imageCacheMaxEntries: parsed.IMAGE_CACHE_MAX_ENTRIES,
    manualUpdate: {
      telegramRecipientIds: parseRecipientIds(
        parsed.UPDATE_TELEGRAM_RECIPIENT_IDS,
        "UPDATE_TELEGRAM_RECIPIENT_IDS",
      ),
      maxRecipientIds: parseRecipientIds(parsed.UPDATE_MAX_RECIPIENT_IDS, "UPDATE_MAX_RECIPIENT_IDS"),
    },
    weatherTimeoutMs: parsed.WEATHER_TIMEOUT_MS,
    weatherRetryCount: parsed.WEATHER_RETRY_COUNT,
    satellite: {
      enabled: parsed.SATELLITE_ENABLED,
      wmsUrl: parsed.SATELLITE_WMS_URL,
      wfsUrl: parsed.SATELLITE_WFS_URL,
      bbox: parseBoundingBox(parsed.SATELLITE_BBOX, "SATELLITE_BBOX"),
      width: parsed.SATELLITE_WIDTH,
      height: parsed.SATELLITE_HEIGHT,
      maxAgeMinutes: parsed.SATELLITE_MAX_AGE_MINUTES,
      cacheMinutes: parsed.SATELLITE_CACHE_MINUTES,
      maxImageBytes: parsed.SATELLITE_MAX_IMAGE_BYTES,
    },
    satelliteAnimation: {
      enabled: parsed.SATELLITE_ENABLED && parsed.SATELLITE_ANIMATION_ENABLED,
      intervalMinutes: parsed.SATELLITE_ANIMATION_INTERVAL_MINUTES,
      windowHours: parsed.SATELLITE_ANIMATION_WINDOW_HOURS,
      retentionHours: parsed.SATELLITE_ANIMATION_RETENTION_HOURS,
      minFrames: parsed.SATELLITE_ANIMATION_MIN_FRAMES,
      directory: parsed.SATELLITE_ANIMATION_DIRECTORY,
      maxBytes: parsed.SATELLITE_ANIMATION_MAX_BYTES,
    },
    cloudAnimation: {
      enabled: parsed.SATELLITE_ENABLED && parsed.CLOUD_ANIMATION_ENABLED,
      directory: parsed.CLOUD_ANIMATION_DIRECTORY,
    },
    cloudDiagnosticCacheMinutes: parsed.CLOUD_DIAGNOSTIC_CACHE_MINUTES,
    personalAnimation: {
      enabled: parsed.SATELLITE_ENABLED
        && parsed.SATELLITE_ANIMATION_ENABLED
        && parsed.PERSONAL_ANIMATION_ENABLED,
      directory: parsed.PERSONAL_ANIMATION_DIRECTORY,
      cacheMinutes: parsed.PERSONAL_ANIMATION_CACHE_MINUTES,
    },
    detailedSatellite: {
      enabled: parsed.DETAILED_SATELLITE_ENABLED,
      bbox: parseBoundingBox(parsed.DETAILED_SATELLITE_BBOX, "DETAILED_SATELLITE_BBOX"),
      width: parsed.DETAILED_SATELLITE_WIDTH,
      height: parsed.DETAILED_SATELLITE_HEIGHT,
      maxAgeHours: parsed.DETAILED_SATELLITE_MAX_AGE_HOURS,
      minCoveragePercent: parsed.DETAILED_SATELLITE_MIN_COVERAGE_PERCENT,
      preferredCoveragePercent: parsed.DETAILED_SATELLITE_PREFERRED_COVERAGE_PERCENT,
      cacheMinutes: parsed.DETAILED_SATELLITE_CACHE_MINUTES,
      passRadiusKm: parsed.DETAILED_SATELLITE_PASS_RADIUS_KM,
      catalogUrl: parsed.EUMETSAT_CATALOG_URL,
      collectionId: parsed.EUMETSAT_SENTINEL_COLLECTION_ID,
      tleS3aUrl: parsed.EUMETSAT_TLE_S3A_URL,
      tleS3bUrl: parsed.EUMETSAT_TLE_S3B_URL,
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

function resolveCopernicusConfig(clientId: string | undefined, clientSecret: string | undefined, lookbackDays: number) {
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error("COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET must be set together");
  return { clientId, clientSecret, lookbackDays };
}

function resolveEumetsatLightningConfig(
  consumerKey: string | undefined,
  consumerSecret: string | undefined,
  windowMinutes: number,
  cacheMinutes: number,
  maxProductBytes: number,
) {
  if (!consumerKey && !consumerSecret) return null;
  if (!consumerKey || !consumerSecret) {
    throw new Error("EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET must be set together");
  }
  return { consumerKey, consumerSecret, windowMinutes, cacheMinutes, maxProductBytes };
}

function resolveMaxConfig(token: string | undefined, publicBaseUrl: string | undefined) {
  if (!token && !publicBaseUrl) return null;
  if (!token || !publicBaseUrl) {
    throw new Error("MAX_BOT_TOKEN and MAX_PUBLIC_BASE_URL must be set together");
  }
  const url = new URL(publicBaseUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MAX_PUBLIC_BASE_URL must be an HTTPS origin without a path");
  }
  return { token, publicBaseUrl: url.origin };
}

function parseBoundingBox(
  value: string,
  variable: "SATELLITE_BBOX" | "DETAILED_SATELLITE_BBOX",
): [number, number, number, number] {
  const numbers = value.split(",").map((item) => Number(item.trim()));
  if (numbers.length !== 4 || numbers.some((item) => !Number.isFinite(item))) {
    throw new Error(`${variable} must contain west,south,east,north`);
  }
  const [west, south, east, north] = numbers;
  if (west === undefined || south === undefined || east === undefined || north === undefined
    || west >= east || south >= north
    || west < -180 || east > 180 || south < -90 || north > 90) {
    throw new Error(`${variable} contains invalid coordinates`);
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
