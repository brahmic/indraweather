import { describe, expect, it, vi } from "vitest";
import { PointForecastService } from "../src/application/point-forecast-service.js";
import { POINT_FORECAST_HOURS } from "../src/domain/point-forecast.js";
import type { ControlPoint, ForecastValue, MarineForecastValue } from "../src/domain/types.js";

const point: ControlPoint = {
  id: "umba",
  name: "Умба",
  shortName: "Умба",
  latitude: 66.679,
  longitude: 34.31,
  order: 60,
  active: true,
};

describe("PointForecastService", () => {
  it("uses the saved forecast run and requires the five-day horizon for the selected point", async () => {
    const database = {
      getForecastValues: vi.fn(async () => weatherValues()),
      getMarineForecastValues: vi.fn(async () => marineValues()),
    };
    const bulletins = {
      getFreshOrRun: vi.fn(async () => ({
        id: "bulletin-1",
        runId: "run-1",
        createdAt: new Date("2026-07-10T21:00:00Z"),
      })),
    };
    const service = new PointForecastService(
      database as never,
      bulletins as never,
      [point],
      { timeZone: "Europe/Moscow" } as never,
    );

    const text = await service.get(point.id);

    expect(bulletins.getFreshOrRun).toHaveBeenCalledWith(POINT_FORECAST_HOURS, point.id);
    expect(database.getForecastValues).toHaveBeenCalledWith("run-1", point.id);
    expect(database.getMarineForecastValues).toHaveBeenCalledWith("run-1", point.id);
    expect(text).toContain("Прогноз на 5 дней · Умба");
  });
});

function weatherValues(): ForecastValue[] {
  return Array.from({ length: 5 }, (_, day) => [
    value("ecmwf", day, 4),
    value("ecmwf", day, 8, 18),
    value("gfs", day, 5),
    value("gfs", day, 10, 18),
  ]).flat();
}

function value(model: "ecmwf" | "gfs", day: number, wind: number, hour = 9): ForecastValue {
  return {
    pointId: point.id,
    model,
    forecastAt: new Date(Date.UTC(2026, 6, 11 + day, hour)),
    receivedAt: new Date("2026-07-10T21:00:00Z"),
    windSpeedMs: wind,
    windGustMs: wind + 3,
    windDirectionDeg: 45,
    precipitationMm: 0,
    precipitationProbabilityPct: null,
    visibilityKm: 10,
    pressureHpa: 1000,
    temperatureC: 8,
  };
}

function marineValues(): MarineForecastValue[] {
  return Array.from({ length: 5 }, (_, day) => ({
    pointId: point.id,
    forecastAt: new Date(Date.UTC(2026, 6, 11 + day, 9)),
    waveHeightM: 0.5,
    waveDirectionDeg: 45,
    wavePeriodSeconds: 3,
    windWaveHeightM: 0.4,
    swellHeightM: 0.1,
    currentSpeedKmh: 0.4,
    currentDirectionDeg: 45,
    seaSurfaceTemperatureC: 8,
  }));
}
