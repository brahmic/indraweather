import "dotenv/config";
import { BulletinService } from "./application/bulletin-service.js";
import { CoastlineOverlayService } from "./application/coastline-overlay-service.js";
import { CloudAnimationService } from "./application/cloud-animation-service.js";
import { CloudDiagnosticService } from "./application/cloud-diagnostic-service.js";
import { RadarService } from "./application/radar-service.js";
import { DeliveryService } from "./application/delivery-service.js";
import { DetailedSatelliteService } from "./application/detailed-satellite-service.js";
import { PublicationService } from "./application/publication-service.js";
import {
  PersonalAnimationService,
  type PersonalAnimationSource,
} from "./application/personal-animation-service.js";
import { SatelliteImageService } from "./application/satellite-image-service.js";
import { AnimationStore, SatelliteAnimationService } from "./application/satellite-animation-service.js";
import { SentinelPassService } from "./application/sentinel-pass-service.js";
import { WindOverlayService } from "./application/wind-overlay-service.js";
import { loadConfig, loadControlPoints } from "./config.js";
import type { MapViewport } from "./domain/map-viewport.js";
import type { DeliveryChannel } from "./delivery/types.js";
import { startHealthServer } from "./health.js";
import { Database } from "./infrastructure/database.js";
import { EumetviewClient } from "./infrastructure/eumetview.js";
import { EumetsatCatalogClient } from "./infrastructure/eumetsat-catalog.js";
import { EumetsatTleClient } from "./infrastructure/eumetsat-tle.js";
import { KolgimetClient } from "./infrastructure/kolgimet.js";
import { OpenMeteoClient } from "./infrastructure/open-meteo.js";
import { OpenMeteoMarineClient } from "./infrastructure/open-meteo-marine.js";
import { CopernicusRadarClient } from "./infrastructure/copernicus-radar.js";
import { StormglassClient } from "./infrastructure/stormglass.js";
import { createLogger } from "./logger.js";
import { Scheduler } from "./scheduler.js";
import { TelegramChannel } from "./delivery/telegram-channel.js";
import { MaxChannel } from "./delivery/max-channel.js";
import { MaxApiClient } from "./infrastructure/max-api.js";

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
const marine = new OpenMeteoMarineClient({
  timeoutMs: config.weatherTimeoutMs,
  retries: config.weatherRetryCount,
});
const stormglass = config.stormglassApiKey
  ? new StormglassClient(config.stormglassApiKey, config.weatherTimeoutMs, config.weatherRetryCount)
  : null;
const kolgimet = new KolgimetClient(config.weatherTimeoutMs, config.weatherRetryCount);
const satelliteOverlay = new CoastlineOverlayService({
  bbox: config.satellite.bbox,
  width: config.satellite.width,
  height: config.satellite.height,
  maxImageBytes: config.satellite.maxImageBytes,
});
const windOverlay = new WindOverlayService(
  database,
  {
    bbox: config.satellite.bbox,
    width: config.satellite.width,
    height: config.satellite.height,
    maxImageBytes: config.satellite.maxImageBytes,
    directionAgreementDeg: config.thresholds.directionAgreementDeg,
    timeZone: config.timeZone,
  },
  logger,
);
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
    satelliteOverlay,
    windOverlay,
    {
      latitude: 66,
      longitude: 33,
      maxAgeMinutes: config.satellite.maxAgeMinutes,
      cacheMinutes: config.satellite.cacheMinutes,
      timeZone: config.timeZone,
    },
  )
  : null;
const [detailWest, detailSouth, detailEast, detailNorth] = config.detailedSatellite.bbox;
const detailedWindOverlay = new WindOverlayService(
  database,
  {
    bbox: config.detailedSatellite.bbox,
    width: config.detailedSatellite.width,
    height: config.detailedSatellite.height,
    maxImageBytes: config.satellite.maxImageBytes,
    directionAgreementDeg: config.thresholds.directionAgreementDeg,
    timeZone: config.timeZone,
  },
  logger,
);
const satelliteAnimation = satellite && config.satelliteAnimation.enabled
  ? new SatelliteAnimationService(
    database,
    satellite,
    satelliteOverlay,
    windOverlay,
    new AnimationStore(config.satelliteAnimation.directory),
    {
      intervalMinutes: config.satelliteAnimation.intervalMinutes,
      windowHours: config.satelliteAnimation.windowHours,
      retentionHours: config.satelliteAnimation.retentionHours,
      minFrames: config.satelliteAnimation.minFrames,
      directory: config.satelliteAnimation.directory,
      maxBytes: config.satelliteAnimation.maxBytes,
      timeZone: config.timeZone,
    },
    logger,
  )
  : null;
const detailedSatellite = config.detailedSatellite.enabled
  ? new DetailedSatelliteService(
    new EumetsatCatalogClient({
      baseUrl: config.detailedSatellite.catalogUrl,
      collectionId: config.detailedSatellite.collectionId,
      bbox: config.detailedSatellite.bbox,
      timeoutMs: config.weatherTimeoutMs,
      retries: config.weatherRetryCount,
    }),
    new EumetviewClient({
      baseUrl: config.satellite.wmsUrl,
      wfsUrl: config.satellite.wfsUrl,
      bbox: config.detailedSatellite.bbox,
      width: config.detailedSatellite.width,
      height: config.detailedSatellite.height,
      timeoutMs: config.weatherTimeoutMs,
      retries: config.weatherRetryCount,
      maxImageBytes: config.satellite.maxImageBytes,
    }),
    new CoastlineOverlayService({
      bbox: config.detailedSatellite.bbox,
      width: config.detailedSatellite.width,
      height: config.detailedSatellite.height,
      maxImageBytes: config.satellite.maxImageBytes,
    }),
    detailedWindOverlay,
    new SentinelPassService(
      new EumetsatTleClient({
        s3aUrl: config.detailedSatellite.tleS3aUrl,
        s3bUrl: config.detailedSatellite.tleS3bUrl,
        timeoutMs: config.weatherTimeoutMs,
        retries: config.weatherRetryCount,
      }),
      {
        latitude: (detailSouth + detailNorth) / 2,
        longitude: (detailWest + detailEast) / 2,
        maxGroundTrackDistanceKm: config.detailedSatellite.passRadiusKm,
      },
    ),
    {
      maxAgeHours: config.detailedSatellite.maxAgeHours,
      minCoveragePercent: config.detailedSatellite.minCoveragePercent,
      preferredCoveragePercent: config.detailedSatellite.preferredCoveragePercent,
      cacheMinutes: config.detailedSatellite.cacheMinutes,
      maxImageBytes: config.satellite.maxImageBytes,
      timeZone: config.timeZone,
    },
  )
  : null;
const cloudDiagnostics = satellite
  ? new CloudDiagnosticService(
    new EumetviewClient({ baseUrl: config.satellite.wmsUrl, wfsUrl: config.satellite.wfsUrl, bbox: config.satellite.bbox, width: config.satellite.width, height: config.satellite.height, timeoutMs: config.weatherTimeoutMs, retries: config.weatherRetryCount, maxImageBytes: config.satellite.maxImageBytes }),
    satelliteOverlay,
    windOverlay,
    { latitude: 66, longitude: 33, timeZone: config.timeZone },
  )
  : null;
const cloudAnimation = cloudDiagnostics && config.cloudAnimation.enabled
  ? new CloudAnimationService(
    database,
    cloudDiagnostics,
    satelliteOverlay,
    windOverlay,
    new AnimationStore(config.cloudAnimation.directory),
    {
      intervalMinutes: config.satelliteAnimation.intervalMinutes,
      windowHours: config.satelliteAnimation.windowHours,
      retentionHours: config.satelliteAnimation.retentionHours,
      minFrames: config.satelliteAnimation.minFrames,
      directory: config.cloudAnimation.directory,
      maxBytes: config.satelliteAnimation.maxBytes,
      timeZone: config.timeZone,
    },
    logger,
  )
  : null;
const personalAnimationSources: PersonalAnimationSource[] = [];
if (satellite && satelliteAnimation) {
  personalAnimationSources.push({
    kind: "satellite" as const,
    getContext: () => "infrared",
    getFrames: async (since: Date) => (await database.getSatelliteAnimationFrames(since)).map((frame) => ({
      observedAt: frame.observedAt,
      source: frame.source,
      label: "EUMETSAT ИК",
    })),
    createFrameFetcher: async (viewport: MapViewport) => {
      const getFrame = await satellite.createInfraredFrameFetcher(viewport);
      return (frame) => getFrame(frame.observedAt);
    },
  });
}
if (cloudDiagnostics && cloudAnimation) {
  personalAnimationSources.push({
    kind: "clouds" as const,
    getContext: () => cloudDiagnostics.getAnimationMode(),
    getFrames: async (since: Date, context: string) => {
      const mode = context === "fog" ? "fog" : "cloudtype";
      return (await database.getCloudAnimationFrames(since, mode)).map((frame) => ({
        observedAt: frame.observedAt,
        source: frame.source,
        label: mode === "cloudtype" ? "EUMETSAT · типы облаков" : "EUMETSAT · туман и низкая облачность",
      }));
    },
    createFrameFetcher: async (viewport: MapViewport, context: string) => {
      const getFrame = await cloudDiagnostics.createAnimationFrameFetcher(
        viewport,
        context === "fog" ? "fog" : "cloudtype",
      );
      return (frame) => getFrame(frame.observedAt);
    },
  });
}
const personalAnimations = config.personalAnimation.enabled && personalAnimationSources.length > 0
  ? new PersonalAnimationService(
    database,
    personalAnimationSources,
    satelliteOverlay,
    windOverlay,
    new AnimationStore(config.personalAnimation.directory),
    {
      windowHours: config.satelliteAnimation.windowHours,
      retentionHours: config.satelliteAnimation.retentionHours,
      minFrames: config.satelliteAnimation.minFrames,
      maxBytes: config.satelliteAnimation.maxBytes,
      cacheMinutes: config.personalAnimation.cacheMinutes,
      timeZone: config.timeZone,
    },
    logger,
  )
  : null;
const radar = config.copernicus
  ? new RadarService(
    new CopernicusRadarClient({ ...config.copernicus, bbox: config.detailedSatellite.bbox, width: config.detailedSatellite.width, height: config.detailedSatellite.height, timeoutMs: config.weatherTimeoutMs, maxImageBytes: config.satellite.maxImageBytes }),
    new CoastlineOverlayService({ bbox: config.detailedSatellite.bbox, width: config.detailedSatellite.width, height: config.detailedSatellite.height, maxImageBytes: config.satellite.maxImageBytes }),
    new EumetviewClient({ baseUrl: config.satellite.wmsUrl, wfsUrl: config.satellite.wfsUrl, bbox: config.detailedSatellite.bbox, width: config.detailedSatellite.width, height: config.detailedSatellite.height, timeoutMs: config.weatherTimeoutMs, retries: config.weatherRetryCount, maxImageBytes: config.satellite.maxImageBytes }),
    detailedWindOverlay,
    config.timeZone,
  )
  : null;

let scheduler: Scheduler;
const bulletinService = new BulletinService(
  database,
  weather,
  marine,
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
  satelliteAnimation,
  detailedSatellite,
  cloudDiagnostics,
  cloudAnimation,
  radar,
  config.timeZone,
  logger,
);
const channels: DeliveryChannel[] = [];
let telegramChannel: TelegramChannel | null = null;
if (config.telegramBotToken) {
  telegramChannel = new TelegramChannel(
    config.telegramBotToken,
    database,
    publicationService,
    points,
    config,
    logger,
    personalAnimations,
  );
  channels.push(telegramChannel);
}
if (personalAnimations && telegramChannel) {
  personalAnimations.setDelivery(telegramChannel.id, async (job, attachment) => {
    if (job.channel !== telegramChannel.id) {
      throw new Error(`Unsupported personal animation channel: ${job.channel}`);
    }
    await telegramChannel.sendPersonalAnimation(job.recipientId, attachment);
  });
}
const maxChannel = config.max
  ? new MaxChannel(
    config.max.token,
    config.max.publicBaseUrl,
    database,
    publicationService,
    points,
    config,
    new MaxApiClient(config.max.token),
    logger,
    personalAnimations,
  )
  : null;
if (personalAnimations && maxChannel) {
  personalAnimations.setDelivery(maxChannel.id, async (job, attachment) => {
    if (job.channel !== maxChannel.id) {
      throw new Error(`Unsupported personal animation channel: ${job.channel}`);
    }
    await maxChannel.sendPersonalAnimation(job.recipientId, attachment);
  });
}
if (maxChannel) channels.push(maxChannel);
const deliveryService = new DeliveryService(channels, logger);
scheduler = new Scheduler(
  config.scheduleTimes,
  config.timeZone,
  config.scheduleRetryMinutes,
  publicationService,
  deliveryService,
  logger,
);

const healthServer = startHealthServer(database, config.port, logger, maxChannel);
if (satelliteAnimation) await satelliteAnimation.start();
if (cloudAnimation) await cloudAnimation.start();
scheduler.start();
await deliveryService.start();
if (personalAnimations && (telegramChannel || maxChannel)) await personalAnimations.start();
if (!config.telegramBotToken) logger.warn("TELEGRAM_BOT_TOKEN is empty; Telegram delivery is disabled");
if (!maxChannel) logger.warn("MAX_BOT_TOKEN is empty; MAX delivery is disabled");
if (!stormglass) logger.warn("STORMGLASS_API_KEY is empty; tide data is disabled");
if (!satellite) logger.warn("Satellite image delivery is disabled");
if (!satelliteAnimation) logger.warn("Satellite animation delivery is disabled");
if (!cloudAnimation) logger.warn("Cloud diagnostic animation delivery is disabled");
if (!detailedSatellite) logger.warn("Detailed satellite image delivery is disabled");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  scheduler.stop();
  await satelliteAnimation?.stop();
  await cloudAnimation?.stop();
  await personalAnimations?.stop();
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
