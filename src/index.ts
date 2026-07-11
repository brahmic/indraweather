import "dotenv/config";
import { BulletinService } from "./application/bulletin-service.js";
import { loadConfig, loadControlPoints } from "./config.js";
import { startHealthServer } from "./health.js";
import { Database } from "./infrastructure/database.js";
import { KolgimetClient } from "./infrastructure/kolgimet.js";
import { OpenMeteoClient } from "./infrastructure/open-meteo.js";
import { StormglassClient } from "./infrastructure/stormglass.js";
import { createLogger } from "./logger.js";
import { Scheduler } from "./scheduler.js";
import { TelegramService } from "./telegram.js";

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

let scheduler: Scheduler;
let telegram: TelegramService | null = null;
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
if (config.telegramBotToken) {
  telegram = new TelegramService(
    config.telegramBotToken,
    database,
    bulletinService,
    points,
    config,
    logger,
  );
}
scheduler = new Scheduler(
  config.scheduleTimes,
  config.timeZone,
  config.scheduleRetryMinutes,
  bulletinService,
  telegram,
  logger,
);

const healthServer = startHealthServer(database, config.port, logger);
scheduler.start();
if (telegram) await telegram.start();
else logger.warn("TELEGRAM_BOT_TOKEN is empty; Telegram delivery is disabled");
if (!stormglass) logger.warn("STORMGLASS_API_KEY is empty; tide data is disabled");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  scheduler.stop();
  if (telegram) await telegram.stop();
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
