import { describe, expect, it } from "vitest";
import { renderPointForecast } from "../src/domain/point-forecast.js";
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

describe("renderPointForecast", () => {
  it("renders five local days with separate weather models and marine conditions", () => {
    const weather: ForecastValue[] = Array.from({ length: 5 }, (_, index) => [
      forecast("ecmwf", index, 9, 4),
      forecast("ecmwf", index, 18, 8),
      forecast("gfs", index, 9, 5),
      forecast("gfs", index, 18, 10),
    ]).flat();
    const marine: MarineForecastValue[] = Array.from({ length: 5 }, (_, index) => marineForecast(index));

    const text = renderPointForecast({
      point,
      generatedAt: new Date("2026-07-10T21:00:00Z"),
      weather,
      marine,
      timeZone: "Europe/Moscow",
    });

    expect(text).toContain("Прогноз на 5 дней · Умба");
    expect((text.match(/День:/gu) ?? [])).toHaveLength(5);
    expect(text).toContain("День: Суббота, 11 июля · ⛅");
    expect(text).toContain("День: Понедельник, 13 июля · 🌧️");
    expect(text).toContain("ECMWF: ветер 4–8 м/с");
    expect(text).toContain("GFS: ветер 5–10 м/с");
    expect(text).toContain("Расхождение: максимальный ветер 2 м/с.");
    expect(text).toContain("Море: волна до 0,8 м; период 4 с; течение до 0,3 уз, СВ; вода +8…+8 °C.");
  });

  it("rejects incomplete forecast data instead of presenting fewer than five days", () => {
    expect(() => renderPointForecast({
      point,
      generatedAt: new Date("2026-07-10T21:00:00Z"),
      weather: [forecast("ecmwf", 0, 9, 4)],
      marine: [],
      timeZone: "Europe/Moscow",
    })).toThrow("Five-day forecast is incomplete");
  });
});

function forecast(model: "ecmwf" | "gfs", day: number, hour: number, wind: number): ForecastValue {
  return {
    pointId: point.id,
    model,
    forecastAt: new Date(Date.UTC(2026, 6, 11 + day, hour)),
    receivedAt: new Date("2026-07-10T21:00:00Z"),
    windSpeedMs: wind,
    windGustMs: wind + 3,
    windDirectionDeg: 45,
    precipitationMm: 1.2,
    precipitationProbabilityPct: model === "gfs" ? 60 : null,
    weatherCode: day === 2 ? 61 : 2,
    visibilityKm: 8,
    pressureHpa: 1000,
    temperatureC: 8,
  };
}

function marineForecast(day: number): MarineForecastValue {
  return {
    pointId: point.id,
    forecastAt: new Date(Date.UTC(2026, 6, 11 + day, 9)),
    waveHeightM: 0.8,
    waveDirectionDeg: 45,
    wavePeriodSeconds: 4,
    windWaveHeightM: 0.5,
    swellHeightM: 0.2,
    currentSpeedKmh: 0.6,
    currentDirectionDeg: 45,
    seaSurfaceTemperatureC: 8,
  };
}
