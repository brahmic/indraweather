import { describe, expect, it } from "vitest";
import { renderBulletin, windDirectionLabel } from "../src/domain/bulletin.js";
import type { BulletinSummary } from "../src/domain/types.js";

const summary: BulletinSummary = {
  generatedAt: "2026-07-11T05:00:00.000Z",
  horizonHours: 24,
  directionChangeThresholdDeg: 45,
  pointSummaries: [{
    point: {
      id: "one",
      name: "Точка <1>",
      latitude: 66,
      longitude: 33,
      order: 1,
      active: true,
    },
    models: {
      ecmwf: {
        model: "ecmwf",
        minWindMs: 3,
        maxWindMs: 7,
        maxGustMs: 10,
        directionStartDeg: 270,
        directionEndDeg: 315,
        windChangeMs: 4,
        windChangeAt: new Date("2026-07-11T12:00:00Z"),
        precipitationMm: 1,
        minVisibilityKm: 8,
        pressureChangeHpa: -3,
        minTemperatureC: 7,
        maxTemperatureC: 11,
      },
    },
    minWindMs: 3,
    maxWindMs: 7,
    maxGustMs: 10,
    precipitationMm: 1,
    minVisibilityKm: 8,
  }],
  agreement: {
    agreed: false,
    windDifferenceMs: null,
    gustDifferenceMs: null,
    directionDifferenceDeg: null,
    eventTimeDifferenceHours: null,
    reasons: ["одна из моделей недоступна"],
  },
  overallMaxWindMs: 7,
  overallMaxGustMs: 10,
  outlook: { maxWindMs: 5, maxGustMs: 8 },
};

describe("renderBulletin", () => {
  it("renders local Moscow time and escapes external text", () => {
    const result = renderBulletin({
      summary,
      warnings: [{
        fingerprint: "x",
        source: "Источник",
        sourceUrl: "https://example.test/",
        rawText: "Ветер <сильный>",
        publishedAt: null,
      }],
      tides: [],
      previousSummary: null,
      nextScheduledAt: new Date("2026-07-11T08:00:00Z"),
      unavailableModels: ["gfs"],
      warningSourceUnavailable: false,
      timeZone: "Europe/Moscow",
    });

    expect(result).toContain("08:00 МСК");
    expect(result).toContain("11:00 МСК");
    expect(result).toContain("Ветер &lt;сильный&gt;");
    expect(result).toContain("Точка &lt;1&gt;");
  });
});

describe("windDirectionLabel", () => {
  it("handles the 0/360 boundary", () => {
    expect(windDirectionLabel(359)).toBe("С");
    expect(windDirectionLabel(45)).toBe("СВ");
  });
});
