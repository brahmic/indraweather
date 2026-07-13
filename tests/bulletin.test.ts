import { describe, expect, it } from "vitest";
import { renderBulletin, windDirectionLabel } from "../src/domain/bulletin.js";
import type { BulletinSummary, MarinePointSummary } from "../src/domain/types.js";

const summary: BulletinSummary = {
  generatedAt: "2026-07-11T05:00:00.000Z",
  horizonHours: 24,
  directionChangeThresholdDeg: 45,
  pointSummaries: [{
    point: {
      id: "one",
      name: "Точка <1>",
      shortName: "Точка",
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

const marine: MarinePointSummary = {
  point: summary.pointSummaries[0]!.point,
  minWaveHeightM: 0.3,
  maxWaveHeightM: 0.7,
  waveDirectionDeg: 45,
  minWavePeriodSeconds: 3,
  maxWavePeriodSeconds: 5,
  maxWindWaveHeightM: 0.4,
  maxSwellHeightM: 0.2,
  maxCurrentKnots: 0.3,
  currentDirectionDeg: 90,
  seaSurfaceTemperatureC: 8,
};

describe("renderBulletin", () => {
  it("renders local Moscow time as channel-neutral plain text", () => {
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
      marine: [],
      marineSourceUnavailable: false,
      weather: { id: "rain", icon: "🌧️", label: "дождь", priority: 8 },
      timeZone: "Europe/Moscow",
    });

    expect(result).toContain("08:00 МСК");
    expect(result).toContain("11:00 МСК");
    expect(result).toContain("Ветер <сильный>");
    expect(result).toContain("Точка <1>");
    expect(result).toContain("Главное\nECMWF: усиление ветра");
    expect(result).toContain("Погодная картина: 🌧️ дождь.");
    expect(result).toContain("Контрольные точки\nДиапазоны: границы ECMWF/GFS, не среднее");
    expect(result).toContain("Период 24–48 часов:");
    expect(result).toContain("Источники\nПогода: Open-Meteo");
    expect(result).not.toContain("<b>");
  });

  it("renders model disagreement without repetitive wording", () => {
    const compared: BulletinSummary = {
      ...summary,
      pointSummaries: summary.pointSummaries.map((point) => ({
        ...point,
        models: {
          ...point.models,
          gfs: { ...point.models.ecmwf!, model: "gfs", maxWindMs: 10, maxGustMs: 14 },
        },
      })),
      agreement: {
        agreed: false,
        windDifferenceMs: 3,
        gustDifferenceMs: 4,
        directionDifferenceDeg: 0,
        eventTimeDifferenceHours: 0,
        reasons: ["расходятся по силе ветра", "расходятся по порывам"],
      },
    };
    const result = renderBulletin({
      summary: compared,
      warnings: [],
      tides: [],
      previousSummary: null,
      nextScheduledAt: null,
      unavailableModels: [],
      warningSourceUnavailable: false,
      marine: [],
      marineSourceUnavailable: false,
      timeZone: "Europe/Moscow",
    });

    expect(result).toContain("Согласованность: существенные расхождения — сила ветра, порывы.");
  });

  it("adds marine conditions to each control point and keeps its disclaimer in the issue footer", () => {
    const result = renderBulletin({
      summary,
      warnings: [],
      tides: [],
      previousSummary: null,
      nextScheduledAt: null,
      unavailableModels: [],
      warningSourceUnavailable: false,
      marine: [marine],
      marineSourceUnavailable: false,
      timeZone: "Europe/Moscow",
    });

    expect(result).toContain("Точка <1>\nВетер 3–7 м/с · порывы до 10 м/с.\nОсадки 1 мм · видимость от 8 км · температура +7…+11 °C.\nМоре: волна 0,3–0,7 м, с СВ, период 3–5 с; ветровая 0,4 м, зыбь 0,2 м; течение до 0,3 уз на В; вода +8 °C.");
    expect(result).not.toContain("\nВолна и вода\n");
    expect(result).toContain("Выпуск\nИзменение: нет предыдущего планового выпуска для сравнения.\nПрогноз морской модели: в губах, за островами и у берега условия могут отличаться.");
  });
});

describe("windDirectionLabel", () => {
  it("handles the 0/360 boundary", () => {
    expect(windDirectionLabel(359)).toBe("С");
    expect(windDirectionLabel(45)).toBe("СВ");
  });
});
