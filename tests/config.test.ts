import { describe, expect, it } from "vitest";
import { loadConfig, loadControlPoints } from "../src/config.js";

describe("loadConfig", () => {
  it("loads added control points as active", async () => {
    const points = await loadControlPoints();

    expect(points).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "pongoma",
        name: "Поньгома",
        latitude: 65.3446,
        longitude: 34.409,
        active: true,
      }),
      expect.objectContaining({
        id: "bolshoy-robyak",
        name: "Остров Большой Робьяк",
        latitude: 65.6256,
        longitude: 34.9084,
        active: true,
      }),
      expect.objectContaining({
        id: "sonostrov",
        name: "Остров Соностров",
        shortName: "Соностров",
        latitude: 66.172405,
        longitude: 34.230645,
        active: true,
      }),
    ]));
  });

  it("builds an encoded PostgreSQL URL from Docker connection fields", () => {
    const config = loadConfig({
      DATABASE_HOST: "postgres",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "indra",
      DATABASE_USER: "indra",
      DATABASE_PASSWORD: "strong:p@ss/word",
    });

    expect(config.databaseUrl).toBe(
      "postgresql://indra:strong%3Ap%40ss%2Fword@postgres:5432/indra",
    );
  });

  it("still supports a direct URL outside Docker", () => {
    const databaseUrl = "postgres://user:password@localhost:5432/test";
    expect(loadConfig({ DATABASE_URL: databaseUrl }).databaseUrl).toBe(databaseUrl);
  });

  it("fails when no database connection is configured", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL|DATABASE_HOST/u);
  });

  it("validates and parses the satellite bounding box", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      SATELLITE_BBOX: "30,64,36,68",
    });
    expect(config.satellite.bbox).toEqual([30, 64, 36, 68]);
    expect(() => loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      SATELLITE_BBOX: "36,64,30,68",
    })).toThrow(/SATELLITE_BBOX/u);
  });

  it("enables a bounded 12-hour satellite animation by default", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/test" });
    expect(config.satelliteAnimation).toMatchObject({
      enabled: true,
      intervalMinutes: 20,
      windowHours: 12,
      retentionHours: 26,
      minFrames: 3,
    });
    expect(config.cloudAnimation).toEqual({
      enabled: true,
      directory: "/var/lib/indra/cloud-animation",
    });
    expect(config).toMatchObject({
      scheduleRecoveryHours: 8,
      deliveryRetry: { intervalSeconds: 30, maxAttempts: 5 },
      forecastDataRetentionDays: 90,
      imageCacheMaxEntries: 16,
      cloudDiagnosticCacheMinutes: 10,
      radarCacheMinutes: 30,
    });
    expect(() => loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      SATELLITE_ANIMATION_WINDOW_HOURS: "25",
    })).toThrow(/SATELLITE_ANIMATION_WINDOW_HOURS/u);
  });

  it("parses detailed satellite quality limits", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      DETAILED_SATELLITE_BBOX: "31.4,65.6,35.8,67.4",
      DETAILED_SATELLITE_MAX_AGE_HOURS: "8",
      DETAILED_SATELLITE_MIN_COVERAGE_PERCENT: "75",
      DETAILED_SATELLITE_PREFERRED_COVERAGE_PERCENT: "75",
    });
    expect(config.detailedSatellite.bbox).toEqual([31.4, 65.6, 35.8, 67.4]);
    expect(config.detailedSatellite.maxAgeHours).toBe(8);
    expect(config.detailedSatellite.minCoveragePercent).toBe(75);
  });

  it("enables MAX only when token and HTTPS origin are both configured", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      MAX_BOT_TOKEN: "secret",
      MAX_PUBLIC_BASE_URL: "https://weather.example.ru",
    });
    expect(config.max).toEqual({
      token: "secret",
      publicBaseUrl: "https://weather.example.ru",
    });
    expect(() => loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      MAX_BOT_TOKEN: "secret",
    })).toThrow(/must be set together/u);
    expect(() => loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      MAX_BOT_TOKEN: "secret",
      MAX_PUBLIC_BASE_URL: "http://weather.example.ru/path",
    })).toThrow(/HTTPS origin/u);
  });

  it("enables Sentinel-1 radar only with complete Copernicus OAuth credentials", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      COPERNICUS_CLIENT_ID: "client",
      COPERNICUS_CLIENT_SECRET: "secret",
    });
    expect(config.copernicus).toMatchObject({ clientId: "client", clientSecret: "secret", lookbackDays: 14 });
    expect(() => loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      COPERNICUS_CLIENT_ID: "client",
    })).toThrow(/COPERNICUS_CLIENT_ID/u);
  });

  it("enables Lightning Imager only with the permanent EUMETSAT credential pair", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      EUMETSAT_CONSUMER_KEY: "consumer-key",
      EUMETSAT_CONSUMER_SECRET: "consumer-secret",
    });
    expect(config.lightning).toEqual({
      consumerKey: "consumer-key",
      consumerSecret: "consumer-secret",
      windowMinutes: 30,
      cacheMinutes: 5,
      maxProductBytes: 60_000_000,
    });
    expect(() => loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      EUMETSAT_CONSUMER_KEY: "consumer-key",
    })).toThrow(/EUMETSAT_CONSUMER_KEY/u);
  });

  it("parses separate recipient allowlists for the hidden manual update command", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      UPDATE_TELEGRAM_RECIPIENT_IDS: " 123,456,123 ",
      UPDATE_MAX_RECIPIENT_IDS: "789",
    });

    expect(config.manualUpdate).toEqual({
      telegramRecipientIds: ["123", "456"],
      maxRecipientIds: ["789"],
    });
    expect(() => loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      UPDATE_TELEGRAM_RECIPIENT_IDS: "not-an-id",
    })).toThrow(/UPDATE_TELEGRAM_RECIPIENT_IDS/u);
  });
});
