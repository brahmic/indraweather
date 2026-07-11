import { describe, expect, it } from "vitest";
import { renderModelDetails } from "../src/domain/model-details.js";
import type { BulletinSummary, ModelSummary, PointSummary, WeatherModel } from "../src/domain/types.js";

describe("renderModelDetails", () => {
  it("shows ECMWF and GFS separately with explicit differences", () => {
    const text = renderModelDetails(summary([point("Кемский рейд", 1)]), "Europe/Moscow");

    expect(text).toContain("Детализация по моделям");
    expect(text).toContain("Значения моделей не усредняются");
    expect(text).toContain("ECMWF: ветер 3–6 м/с");
    expect(text).toContain("GFS: ветер 5–9 м/с");
    expect(text).toContain("Расхождение: максимальный ветер 3 м/с, порывы 4 м/с");
    expect(text).toContain("усиление на 3 м/с около 15:00 МСК");
  });

  it("fits five configured points into one Telegram message", () => {
    const points = [
      "Кемский рейд",
      "Куземская губа",
      "Чупинская губа",
      "Ковдинская губа",
      "Кандалакшский рейд",
    ].map(point);
    const text = renderModelDetails(summary(points), "Europe/Moscow");

    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain("Кандалакшский рейд");
  });
});

function summary(pointSummaries: PointSummary[]): BulletinSummary {
  return {
    generatedAt: "2026-07-11T11:00:00.000Z",
    horizonHours: 24,
    directionChangeThresholdDeg: 45,
    pointSummaries,
    agreement: {
      agreed: false,
      windDifferenceMs: 3,
      gustDifferenceMs: 4,
      directionDifferenceDeg: 45,
      eventTimeDifferenceHours: 1,
      reasons: ["расходятся по силе ветра", "расходятся по порывам"],
    },
    overallMaxWindMs: 9,
    overallMaxGustMs: 14,
    outlook: { maxWindMs: 8, maxGustMs: 12 },
  };
}

function point(name: string, index = 0): PointSummary {
  return {
    point: {
      id: `point-${index}`,
      name,
      latitude: 66,
      longitude: 33,
      order: index,
      active: true,
    },
    models: {
      ecmwf: model("ecmwf", 3, 6, 10, 225, 270),
      gfs: model("gfs", 5, 9, 14, 270, 315),
    },
    minWindMs: 3,
    maxWindMs: 9,
    maxGustMs: 14,
    precipitationMm: 3.8,
    minVisibilityKm: 8,
  };
}

function model(
  modelName: WeatherModel,
  minWindMs: number,
  maxWindMs: number,
  maxGustMs: number,
  directionStartDeg: number,
  directionEndDeg: number,
): ModelSummary {
  return {
    model: modelName,
    minWindMs,
    maxWindMs,
    maxGustMs,
    directionStartDeg,
    directionEndDeg,
    windChangeMs: 3,
    windChangeAt: new Date("2026-07-11T12:00:00Z"),
    precipitationMm: modelName === "ecmwf" ? 1.2 : 3.8,
    minVisibilityKm: modelName === "ecmwf" ? 14 : 8,
    pressureChangeHpa: modelName === "ecmwf" ? -3 : -5,
    minTemperatureC: 7,
    maxTemperatureC: 12,
  };
}
