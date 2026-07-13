import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CoastlineOverlayService } from "../src/application/coastline-overlay-service.js";
import type { ControlPoint } from "../src/domain/types.js";

describe("CoastlineOverlayService", () => {
  it("projects the coast and adds settlement context", async () => {
    const input = await sharp({
      create: {
        width: 100,
        height: 80,
        channels: 3,
        background: "#8aa0aa",
      },
    }).png().toBuffer();
    const service = new CoastlineOverlayService({
      bbox: [30, 64, 36, 68],
      width: 100,
      height: 80,
      maxImageBytes: 100_000,
      points: [
        { id: "kem", name: "Кемский рейд", shortName: "Кемь", latitude: 64.983, longitude: 34.748, order: 10, active: true },
        { id: "umba", name: "Умба", shortName: "Умба", latitude: 66.679, longitude: 34.31, order: 60, active: true },
      ] satisfies ControlPoint[],
    });

    const output = await service.apply(input, [[[30, 64], [36, 68]]]);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const center = (40 * info.width + 50) * info.channels;
    const kemiMarker = (60 * info.width + 79) * info.channels;
    const umbaMarker = (26 * info.width + 72) * info.channels;

    expect(info.width).toBe(100);
    expect(info.height).toBe(80);
    expect([...data.subarray(center, center + 3)]).not.toEqual([138, 160, 170]);
    expect([...data.subarray(kemiMarker, kemiMarker + 3)]).not.toEqual([138, 160, 170]);
    expect([...data.subarray(umbaMarker, umbaMarker + 3)]).not.toEqual([138, 160, 170]);
  });
});
