import { describe, expect, it } from "vitest";
import { renderBulletin, windDirectionLabel } from "../src/domain/bulletin.js";
import type { BulletinSummary, MarinePointSummary, TideExtreme } from "../src/domain/types.js";

const summary: BulletinSummary = {
  generatedAt: "2026-07-11T05:00:00.000Z",
  horizonHours: 24,
  directionChangeThresholdDeg: 45,
  directionAgreementThresholdDeg: 45,
  eventTimeAgreementHours: 2,
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
        directionChangeStartDeg: 270,
        directionChangeEndDeg: 315,
        directionChangeStartedAt: new Date("2026-07-11T09:00:00Z"),
        directionChangeAt: new Date("2026-07-11T12:00:00Z"),
        windChangeMs: 4,
        windChangeStartedAt: new Date("2026-07-11T09:00:00Z"),
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

const tides: TideExtreme[] = [
  {
    pointId: "one",
    extremeAt: new Date("2026-07-11T08:00:00Z"),
    type: "high",
    heightM: 1.4,
    source: "Stormglass",
    stationName: "Тестовая станция",
    stationDistanceKm: 31.6,
  },
  {
    pointId: "one",
    extremeAt: new Date("2026-07-11T14:00:00Z"),
    type: "low",
    heightM: -1.1,
    source: "Stormglass",
    stationName: "Тестовая станция",
    stationDistanceKm: 31.6,
  },
];

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
    expect(result).toContain("Ветер: 3–7 м/с · порывы до 10 м/с.");
    expect(result).not.toContain("Поворот ветра:");
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

    expect(result).toContain("Точка <1>\nВетер: 3–7 м/с · порывы до 10 м/с.\nДинамика: сравнение неполное.\nECMWF: усиление на 4 м/с с 12:00 до 15:00 МСК.\nGFS: нет данных.\nПоворот: сравнение неполное.\nECMWF: З → СЗ с 12:00 до 15:00 МСК.\nGFS: нет данных.\nОсадки 1 мм · видимость от 8 км · температура +7…+11 °C.\nМоре: волна 0,3–0,7 м, с СВ, период 3–5 с; ветровая 0,4 м, зыбь 0,2 м; течение до 0,3 уз на В; вода +8 °C.");
    expect(result).not.toContain("\nВолна и вода\n");
    expect(result).toContain("Выпуск\nИзменение: нет предыдущего планового выпуска для сравнения.\nПрогноз морской модели: в губах, за островами и у берега условия могут отличаться.");
  });

  it("adds a point-specific tide phase and flags a distant station as approximate", () => {
    const result = renderBulletin({
      summary,
      warnings: [],
      tides,
      previousSummary: null,
      nextScheduledAt: null,
      unavailableModels: [],
      warningSourceUnavailable: false,
      marine: [marine],
      marineSourceUnavailable: false,
      timeZone: "Europe/Moscow",
    });

    expect(result).toContain(
      "Прилив: вода прибывает; полная вода 11 июля в 11:00 МСК, малая вода 11 июля в 17:00 МСК Ориентировочно: станция Тестовая станция, 31,6 км.",
    );
    expect(result).not.toContain("Обстановка\nПрилив:");
  });

  it("adds agreed wind direction and significant turn to a control point", () => {
    const compared: BulletinSummary = {
      ...summary,
      pointSummaries: summary.pointSummaries.map((point) => ({
        ...point,
        models: {
          ecmwf: point.models.ecmwf!,
          gfs: {
            ...point.models.ecmwf!,
            model: "gfs",
            directionStartDeg: 250,
            directionEndDeg: 320,
            directionChangeStartDeg: 250,
            directionChangeEndDeg: 320,
            windChangeMs: 0,
            windChangeStartedAt: null,
            windChangeAt: null,
          },
        },
      })),
      agreement: {
        agreed: true,
        windDifferenceMs: 0,
        gustDifferenceMs: 0,
        directionDifferenceDeg: 5,
        eventTimeDifferenceHours: 0,
        reasons: [],
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

    expect(result).toContain("Ветер: З 3–7 м/с · порывы до 10 м/с.\nДинамика: модели расходятся.\nECMWF: усиление на 4 м/с с 12:00 до 15:00 МСК.\nGFS: без заметного изменения.\nПоворот: З → СЗ с 12:00 до 15:00 МСК.");
  });

  it("adds agreed wind dynamics with a combined time interval to a control point", () => {
    const compared: BulletinSummary = {
      ...summary,
      pointSummaries: summary.pointSummaries.map((point) => ({
        ...point,
        models: {
          ecmwf: point.models.ecmwf!,
          gfs: {
            ...point.models.ecmwf!,
            model: "gfs",
            windChangeMs: 3,
            windChangeStartedAt: new Date("2026-07-11T10:00:00Z"),
            windChangeAt: new Date("2026-07-11T13:00:00Z"),
          },
        },
      })),
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

    expect(result).toContain("Динамика: усиление на 3–4 м/с с 12:00 до 16:00 МСК.");
  });

  it("shows both model scenarios when models predict opposite changes", () => {
    const compared: BulletinSummary = {
      ...summary,
      pointSummaries: summary.pointSummaries.map((point) => ({
        ...point,
        models: {
          ecmwf: point.models.ecmwf!,
          gfs: {
            ...point.models.ecmwf!,
            model: "gfs",
            windChangeMs: -3,
          },
        },
      })),
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

    expect(result).toContain(
      "Динамика: модели расходятся.\nECMWF: усиление на 4 м/с с 12:00 до 15:00 МСК.\nGFS: ослабление на 3 м/с с 12:00 до 15:00 МСК.",
    );
  });

  it("shows a stable model when only one model predicts a notable change", () => {
    const compared: BulletinSummary = {
      ...summary,
      pointSummaries: summary.pointSummaries.map((point) => ({
        ...point,
        models: {
          ecmwf: point.models.ecmwf!,
          gfs: {
            ...point.models.ecmwf!,
            model: "gfs",
            windChangeMs: 0,
            windChangeStartedAt: null,
            windChangeAt: null,
          },
        },
      })),
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

    expect(result).toContain(
      "Динамика: модели расходятся.\nECMWF: усиление на 4 м/с с 12:00 до 15:00 МСК.\nGFS: без заметного изменения.",
    );
  });

  it("does not show a combined direction when models disagree at a point", () => {
    const compared: BulletinSummary = {
      ...summary,
      pointSummaries: summary.pointSummaries.map((point) => ({
        ...point,
        models: {
          ecmwf: point.models.ecmwf!,
          gfs: {
            ...point.models.ecmwf!,
            model: "gfs",
            directionStartDeg: 90,
            directionEndDeg: 135,
            directionChangeStartDeg: 90,
            directionChangeEndDeg: 135,
          },
        },
      })),
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

    expect(result).toContain("Направление: модели расходятся.");
    expect(result).toContain(
      "Поворот: модели расходятся.\nECMWF: З → СЗ с 12:00 до 15:00 МСК.\nGFS: В → ЮВ с 12:00 до 15:00 МСК.",
    );
  });
});

describe("windDirectionLabel", () => {
  it("handles the 0/360 boundary", () => {
    expect(windDirectionLabel(359)).toBe("С");
    expect(windDirectionLabel(45)).toBe("СВ");
  });
});
