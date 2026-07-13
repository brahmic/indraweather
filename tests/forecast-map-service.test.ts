import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ForecastMapService } from "../src/application/forecast-map-service.js";

describe("ForecastMapService", () => {
  it("renders a cartographic forecast image from one saved model run", async () => {
    const forecastAt = new Date("2026-07-13T09:00:00Z");
    const snapshot = {
      forecastAt,
      points: [
        {
          pointId: "kem", name: "Кемь", latitude: 65, longitude: 34,
          model: "ecmwf" as const, speedMs: 7, directionDeg: 225, weatherCode: 2, temperatureC: 8,
        },
        {
          pointId: "kem", name: "Кемь", latitude: 65, longitude: 34,
          model: "gfs" as const, speedMs: 9, directionDeg: 230, weatherCode: 61, temperatureC: 10,
        },
        {
          pointId: "pongoma", name: "Поньгома", latitude: 65.3446, longitude: 34.409,
          model: "ecmwf" as const, speedMs: 6, directionDeg: 270, weatherCode: 0, temperatureC: 7,
        },
        {
          pointId: "pongoma", name: "Поньгома", latitude: 65.3446, longitude: 34.409,
          model: "gfs" as const, speedMs: 7, directionDeg: 275, weatherCode: 0, temperatureC: 9,
        },
      ],
    };
    const database = { getForecastMapSnapshot: vi.fn(async () => snapshot) };
    const coastlineClient = {
      getCoastline: vi.fn(async () => [[[30, 64], [36, 68]]]),
      withViewport: vi.fn(),
    };
    coastlineClient.withViewport.mockReturnValue(coastlineClient);
    const coastlineOverlay = {
      apply: vi.fn(async (image: Uint8Array) => image),
      withViewport: vi.fn(),
    };
    coastlineOverlay.withViewport.mockReturnValue(coastlineOverlay);
    const service = new ForecastMapService(
      database as never,
      coastlineClient as never,
      coastlineOverlay as never,
      {
        bbox: [30, 64, 36, 68],
        width: 1000,
        height: 800,
        maxImageBytes: 1_000_000,
        timeZone: "Europe/Moscow",
        points: [
          { id: "kem", shortName: "Кемь" },
          { id: "pongoma", shortName: "Поньгома" },
        ],
      },
      { warn: vi.fn() } as never,
    );

    const result = await service.get("run-1", new Date("2026-07-13T08:40:00Z"));
    const { data, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    const header = (18 * info.width + 18) * info.channels;
    const kemPointMarker = (600 * info.width + 667) * info.channels;
    const pongomaPointMarker = (531 * info.width + 735) * info.channels;
    const temperatureRegion = data.subarray(
      (510 * info.width + 819) * info.channels,
      (527 * info.width + 874) * info.channels,
    );

    expect(database.getForecastMapSnapshot).toHaveBeenCalledWith("run-1", new Date("2026-07-13T08:40:00Z"));
    expect(coastlineOverlay.apply).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Array),
      { includeSettlements: false },
    );
    expect(result.filename).toBe("forecast-map-2026-07-13T09-00-00Z.png");
    expect(result.caption).toContain("E/G: сценарии различаются");
    expect([...data.subarray(header, header + 3)]).not.toEqual([82, 127, 145]);
    expect([...data.subarray(kemPointMarker, kemPointMarker + 3)]).toEqual([255, 213, 79]);
    expect([...temperatureRegion].some((value) => value < 100)).toBe(true);
    expect([...data.subarray(pongomaPointMarker, pongomaPointMarker + 3)]).toEqual([255, 213, 79]);

    const viewport = {
      bbox: [33, 64.5, 35, 66.5] as [number, number, number, number],
      width: 800,
      height: 600,
    };
    await service.get("run-1", new Date("2026-07-13T08:40:00Z"), viewport);
    expect(coastlineClient.withViewport).toHaveBeenCalledWith(viewport);
    expect(coastlineOverlay.withViewport).toHaveBeenCalledWith(viewport);
  });
});
