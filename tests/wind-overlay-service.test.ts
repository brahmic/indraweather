import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { WindOverlayService } from "../src/application/wind-overlay-service.js";

describe("WindOverlayService", () => {
  it("draws the forecast header and wind vectors from the saved model values", async () => {
    const referenceAt = new Date("2026-07-12T12:00:00Z");
    const database = {
      getLatestWindOverlay: vi.fn(async () => ({
        forecastAt: referenceAt,
        points: [
          {
            pointId: "kem", name: "Кемь", latitude: 65, longitude: 34,
            model: "ecmwf" as const, speedMs: 7, directionDeg: 225,
          },
          {
            pointId: "kem", name: "Кемь", latitude: 65, longitude: 34,
            model: "gfs" as const, speedMs: 9, directionDeg: 230,
          },
          {
            pointId: "chupa", name: "Чупа", latitude: 66, longitude: 33,
            model: "ecmwf" as const, speedMs: 8, directionDeg: 90,
          },
          {
            pointId: "chupa", name: "Чупа", latitude: 66, longitude: 33,
            model: "gfs" as const, speedMs: 11, directionDeg: 260,
          },
        ],
      })),
    };
    const input = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: "#587887" },
    }).png().toBuffer();
    const service = new WindOverlayService(
      database as never,
      {
        bbox: [30, 64, 36, 68],
        width: 1000,
        height: 800,
        maxImageBytes: 1_000_000,
        directionAgreementDeg: 45,
        timeZone: "Europe/Moscow",
      },
      { warn: vi.fn() } as never,
    );

    const output = await service.apply(input, referenceAt);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const headerPixel = (16 * info.width + 16) * info.channels;
    const kemPoint = (600 * info.width + 667) * info.channels;

    expect(database.getLatestWindOverlay).toHaveBeenCalledWith(referenceAt);
    expect([...data.subarray(headerPixel, headerPixel + 3)]).not.toEqual([88, 120, 135]);
    expect([...data.subarray(kemPoint, kemPoint + 3)]).not.toEqual([88, 120, 135]);
  });
});
