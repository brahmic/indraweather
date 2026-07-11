import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
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

  it("parses detailed satellite quality limits", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      DETAILED_SATELLITE_BBOX: "31.4,65.6,35.8,67.4",
      DETAILED_SATELLITE_MAX_AGE_HOURS: "8",
      DETAILED_SATELLITE_MIN_COVERAGE_PERCENT: "75",
    });
    expect(config.detailedSatellite.bbox).toEqual([31.4, 65.6, 35.8, 67.4]);
    expect(config.detailedSatellite.maxAgeHours).toBe(8);
    expect(config.detailedSatellite.minCoveragePercent).toBe(75);
  });
});
