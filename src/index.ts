import "dotenv/config";
import { BulletinService } from "./application/bulletin-service.js";
import { CoastlineOverlayService } from "./application/coastline-overlay-service.js";
import { DeliveryService } from "./application/delivery-service.js";
import { PublicationService } from "./application/publication-service.js";
import { SatelliteImageService } from "./application/satellite-image-service.js";
import { loadConfig, loadControlPoints } from "./config.js";
import type { DeliveryChannel } from "./delivery/types.js";
import { startHealthServer } from "./health.js";
import { Database } from "./infrastructure/database.js";
import { EumetviewClient } from "./infrastructure/eumetview.js";
import { KolgimetClient } from "./infrastructure/kolgimet.js";
import { OpenMeteoClient } from "./infrastructure/open-meteo.js";
import { StormglassClient } from "./infrastructure/stormglass.js";
import { createLogger } from "./logger.js";
import { Scheduler } from "./scheduler.js";
import { TelegramChannel } from "./delivery/telegram-channel.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = new Database(config.databaseUrl);
const points = await loadControlPoints();

await database.migrate();
await database.syncControlPoints(points);

const weather = new OpenMeteoClient({
  timeoutMs: config.weatherTimeoutMs,
  retries: config.weatherRetryCount,
});
const stormglass = config.stormglassApiKey
  ? new StormglassClient(config.stormglassApiKey, config.weatherTimeoutMs, config.weatherRetryCount)
  : null;
const kolgimet = new KolgimetClient(config.weatherTimeoutMs, config.weatherRetryCount);
const satellite = config.satellite.enabled
  ? new SatelliteImageService(
    new EumetviewClient({
      baseUrl: config.satellite.wmsUrl,
      wfsUrl: config.satellite.wfsUrl,
      bbox: config.satellite.bbox,
      width: config.satellite.width,
      height: config.satellite.height,
      timeoutMs: config.weatherTimeoutMs,
      retries: config.weatherRetryCount,
      maxImageBytes: config.satellite.maxImageBytes,
    }),
    new CoastlineOverlayService({
      bbox: config.satellite.bbox,
      width: config.satellite.width,
      height: config.satellite.height,
      maxImageBytes: config.satellite.maxImageBytes,
    }),
    {
      latitude: 66,
      longitude: 33,
      maxAgeMinutes: config.satellite.maxAgeMinutes,
      cacheMinutes: config.satellite.cacheMinutes,
      timeZone: config.timeZone,
    },
  )
  : null;

let scheduler: Scheduler;
const bulletinService = new BulletinService(
  database,
  weather,
  stormglass,
  kolgimet,
  points,
  config,
  logger,
  () => scheduler?.nextRun() ?? null,
);
const publicationService = new PublicationService(
  bulletinService,
  satellite,
  logger,
);
const channels: DeliveryChannel[] = [];
if (config.telegramBotToken) {
  channels.push(new TelegramChannel(
    config.telegramBotToken,
    database,
    publicationService,
    points,
    config,
    logger,
  ));
}
const deliveryService = new DeliveryService(channels, logger);
scheduler = new Scheduler(
  config.scheduleTimes,
  config.timeZone,
  config.scheduleRetryMinutes,
  publicationService,
  deliveryService,
  logger,
);

const healthServer = startHealthServer(database, config.port, logger);
scheduler.start();
await deliveryService.start();
if (!config.telegramBotToken) logger.warn("TELEGRAM_BOT_TOKEN is empty; Telegram delivery is disabled");
if (!stormglass) logger.warn("STORMGLASS_API_KEY is empty; tide data is disabled");
if (!satellite) logger.warn("Satellite image delivery is disabled");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  scheduler.stop();
  await deliveryService.stop();
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown(signal).then(() => process.exit(0)).catch((error: unknown) => {
      logger.error({ error }, "Shutdown failed");
      process.exit(1);
    });
  });
}
