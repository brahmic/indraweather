import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CoastlineOverlayService } from "../src/application/coastline-overlay-service.js";

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
    });

    const output = await service.apply(input, [[[30, 64], [36, 68]]]);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const center = (40 * info.width + 50) * info.channels;
    const kemiMarker = (60 * info.width + 79) * info.channels;

    expect(info.width).toBe(100);
    expect(info.height).toBe(80);
    expect([...data.subarray(center, center + 3)]).not.toEqual([138, 160, 170]);
    expect([...data.subarray(kemiMarker, kemiMarker + 3)]).not.toEqual([138, 160, 170]);
  });
});
