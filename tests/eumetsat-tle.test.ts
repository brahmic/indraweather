import { describe, expect, it } from "vitest";
import { parseTleJavaScript } from "../src/infrastructure/eumetsat-tle.js";

describe("parseTleJavaScript", () => {
  it("extracts EUMETSAT JavaScript TLE pairs", () => {
    const source = `
      s3a_TLE[i++] = "1 41335U 16011A   26191.00000000  .00000000  00000+0 -27718-1 0 00014";
      s3a_TLE[i++] = "2 41335  98.6233 258.0549 0001489  94.9299 220.1645 14.26750527541319";
    `;
    expect(parseTleJavaScript(source, "Sentinel-3A")).toEqual([{
      platform: "Sentinel-3A",
      line1: expect.stringMatching(/^1 41335/u),
      line2: expect.stringMatching(/^2 41335/u),
    }]);
  });
});
