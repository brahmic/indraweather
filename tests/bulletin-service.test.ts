import { describe, expect, it, vi } from "vitest";
import { BulletinService } from "../src/application/bulletin-service.js";
import type { BulletinRecord } from "../src/infrastructure/database.js";
import type { ControlPoint, ForecastValue, WeatherModel } from "../src/domain/types.js";

const now = new Date("2026-07-20T08:00:00Z");
const points: ControlPoint[] = Array.from({ length: 4 }, (_, index) => ({
  id: `point-${index + 1}`,
  name: `Точка ${index + 1}`,
  shortName: `Т${index + 1}`,
  latitude: 66 + index / 10,
  longitude: 33 + index / 10,
  order: index,
  active: true,
}));

describe("BulletinService weather collection", () => {
  it("uses model batches first and retries failed batches in bounded chunks", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const batchSizes: number[] = [];
    const weather = {
      getForecasts: vi.fn(async (model: WeatherModel, batch: ControlPoint[]) => {
        batchSizes.push(batch.length);
        if (batch.length === points.length) throw new Error("batch unavailable");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return batch.map((point) => forecast(point.id, model));
      }),
    };
    const database = { getLatestForecastValues: vi.fn(async () => []) };
    const logger = { warn: vi.fn() };
    const service = new BulletinService(
      database as never,
      weather as never,
      {} as never,
      null,
      {} as never,
      points,
      { weatherFallbackMaxAgeHours: 12 } as never,
      logger as never,
      () => null,
    );

    const result = await (service as unknown as {
      loadWeather(
        activePoints: ControlPoint[],
        startedAt: Date,
        errors: string[],
      ): Promise<{
        values: ForecastValue[];
        currentPoints: Record<WeatherModel, number>;
      }>;
    }).loadWeather(points, now, []);

    expect(batchSizes.slice(0, 2)).toEqual([4, 4]);
    expect(batchSizes.slice(2).sort()).toEqual([1, 1, 3, 3]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result.currentPoints).toEqual({ ecmwf: 4, gfs: 4 });
    expect(result.values).toHaveLength(8);
    expect(database.getLatestForecastValues).not.toHaveBeenCalled();
  });

  it("creates a new scheduled bulletin id while preserving the real age of fallback data", async () => {
    const source = {
      id: "old-bulletin",
      runId: "old-run",
      content: [
        "Кемь — Кандалакша · гидрометеосводка",
        "Сформировано: 20.07.2026, 05:00",
        "",
        "Главное",
        "Следующий выпуск: 20.07.2026, 11:00.",
      ].join("\n"),
      contentFormat: "plain",
      summary: {
        generatedAt: "2026-07-20T02:00:00.000Z",
        pointSummaries: [{}],
      },
      createdAt: new Date("2026-07-20T07:59:00.000Z"),
    } as unknown as BulletinRecord;
    const saved = { ...source, id: "fallback-bulletin" };
    const database = {
      getScheduledBulletin: vi.fn(async () => null),
      getLatestBulletin: vi.fn(async () => source),
      saveBulletin: vi.fn(async () => saved),
    };
    const service = new BulletinService(
      database as never,
      {} as never,
      {} as never,
      null,
      {} as never,
      [],
      { timeZone: "Europe/Moscow" } as never,
      {} as never,
      () => new Date("2026-07-20T14:00:00.000Z"),
    );

    const result = await service.createScheduledFallback(new Date("2026-07-20T08:00:00.000Z"));

    expect(result.id).toBe("fallback-bulletin");
    expect(database.saveBulletin).toHaveBeenCalledWith(
      "old-run",
      "scheduled",
      "scheduled:2026-07-20T08:00:00.000Z",
      expect.stringContaining("используются данные от 20.07.2026, 05:00"),
      source.summary,
    );
  });
});

function forecast(pointId: string, model: WeatherModel): ForecastValue {
  return {
    pointId,
    model,
    forecastAt: new Date("2026-07-20T09:00:00Z"),
    receivedAt: now,
    windSpeedMs: 5,
    windGustMs: 8,
    windDirectionDeg: 270,
    precipitationMm: 0,
    precipitationProbabilityPct: null,
    weatherCode: 2,
    visibilityKm: 10,
    pressureHpa: 1010,
    temperatureC: 12,
  };
}
