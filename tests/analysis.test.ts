import { describe, expect, it } from "vitest";
import { analyzeForecast, circularDifference } from "../src/domain/analysis.js";
import type { ControlPoint, ForecastValue, WeatherModel } from "../src/domain/types.js";

const point: ControlPoint = {
  id: "test",
  name: "Тестовая точка",
  shortName: "Тест",
  latitude: 66,
  longitude: 33,
  order: 1,
  active: true,
};

describe("circularDifference", () => {
  it("uses the shortest distance through north", () => {
    expect(circularDifference(359, 1)).toBe(2);
    expect(circularDifference(10, 350)).toBe(20);
  });
});

describe("analyzeForecast", () => {
  it("finds wind change and model disagreement", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    const values = [
      ...series("ecmwf", now, [2, 2, 2, 6, 7], 270),
      ...series("gfs", now, [2, 2, 2, 3, 3], 350),
    ];
    const summary = analyzeForecast([point], values, now, {
      windChangeMs: 2,
      windAgreementMs: 2,
      gustAgreementMs: 3,
      directionChangeDeg: 45,
      directionAgreementDeg: 45,
      eventTimeAgreementHours: 2,
    });

    expect(summary.overallMaxWindMs).toBe(7);
    expect(summary.pointSummaries[0]?.models.ecmwf?.windChangeMs).toBe(5);
    expect(summary.pointSummaries[0]?.models.ecmwf?.windChangeStartedAt)
      .toEqual(new Date("2026-07-11T01:00:00Z"));
    expect(summary.pointSummaries[0]?.models.ecmwf?.windChangeAt)
      .toEqual(new Date("2026-07-11T04:00:00Z"));
    expect(summary.agreement.agreed).toBe(false);
    expect(summary.agreement.reasons).toContain("расходятся по силе ветра");
    expect(summary.agreement.reasons).toContain("расходятся по направлению");
    expect(summary.agreement.reasons).toContain("расходятся по наличию заметного изменения ветра");
  });

  it("does not report changes below the configured threshold", () => {
    const now = new Date("2026-07-11T00:00:00Z");
    const summary = analyzeForecast([point], series("ecmwf", now, [2, 2.2, 2.5, 3], 10), now, {
      windChangeMs: 2,
      windAgreementMs: 2,
      gustAgreementMs: 3,
      directionChangeDeg: 45,
      directionAgreementDeg: 45,
      eventTimeAgreementHours: 2,
    });
    expect(summary.pointSummaries[0]?.models.ecmwf?.windChangeStartedAt).toBeNull();
    expect(summary.pointSummaries[0]?.models.ecmwf?.windChangeAt).toBeNull();
  });
});

function series(
  model: WeatherModel,
  start: Date,
  speeds: number[],
  direction: number,
): ForecastValue[] {
  return speeds.map((speed, index) => ({
    pointId: point.id,
    model,
    forecastAt: new Date(start.getTime() + index * 3_600_000),
    receivedAt: start,
    windSpeedMs: speed,
    windGustMs: speed + 2,
    windDirectionDeg: direction,
    precipitationMm: index === 2 ? 0.5 : 0,
    precipitationProbabilityPct: null,
    weatherCode: 2,
    visibilityKm: 20,
    pressureHpa: 1000 - index,
    temperatureC: 10,
  }));
}
