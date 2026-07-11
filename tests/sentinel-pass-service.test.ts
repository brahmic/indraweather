import { describe, expect, it } from "vitest";
import { predictNextPass } from "../src/application/sentinel-pass-service.js";

describe("predictNextPass", () => {
  it("finds a daylight pass from official-format TLE data", () => {
    const next = predictNextPass([{
      platform: "Sentinel-3A",
      line1: "1 41335U 16011A   26191.00000000  .00000000  00000+0 -27718-1 0 00014",
      line2: "2 41335  98.6233 258.0549 0001489  94.9299 220.1645 14.26750527541319",
    }], new Date("2026-07-10T06:00:00Z"), {
      latitude: 66.5,
      longitude: 33.6,
      maxGroundTrackDistanceKm: 450,
    });
    expect(next).not.toBeNull();
    expect(next?.getTime()).toBeGreaterThan(new Date("2026-07-10T06:10:00Z").getTime());
    expect(next?.getTime()).toBeLessThan(new Date("2026-07-12T06:00:00Z").getTime());
  });
});
