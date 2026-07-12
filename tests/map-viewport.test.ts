import { describe, expect, it } from "vitest";
import {
  changeMapViewport,
  createMapViewport,
  formatMapExtent,
} from "../src/domain/map-viewport.js";

describe("map viewport", () => {
  const initial = createMapViewport([30, 64, 36, 68], 1000, 800);

  it("moves the map by about 30 kilometres", () => {
    const movedNorth = changeMapViewport(initial, "up");
    const movedWest = changeMapViewport(initial, "left");

    expect(movedNorth.bbox[1] - initial.bbox[1]).toBeCloseTo(30 / 111.32, 3);
    expect(movedWest.bbox[0]).toBeLessThan(initial.bbox[0] - 0.6);
    expect(movedNorth.bbox[2] - movedNorth.bbox[0]).toBeCloseTo(6, 6);
  });

  it("changes zoom while preserving the map centre", () => {
    const zoomed = changeMapViewport(initial, "zoom-in");
    const expanded = changeMapViewport(zoomed, "zoom-out");

    expect(zoomed.bbox[3] - zoomed.bbox[1]).toBeCloseTo(3.2, 6);
    expect((zoomed.bbox[0] + zoomed.bbox[2]) / 2).toBeCloseTo(33, 6);
    expect(expanded.bbox).toEqual(initial.bbox);
  });

  it("reports the approximate current map extent", () => {
    expect(formatMapExtent(initial)).toMatch(/^Охват: примерно \d+ × \d+ км$/u);
  });
});
