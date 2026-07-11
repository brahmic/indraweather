import { describe, expect, it } from "vitest";
import { formatDetailedSatelliteSkip } from "../src/application/publication-service.js";

describe("formatDetailedSatelliteSkip", () => {
  it("states the skip reason and the calculated next pass in local time", () => {
    const text = formatDetailedSatelliteSkip({
      status: "skipped",
      reason: { code: "low-coverage", coveragePercent: 46.4, minCoveragePercent: 70 },
      nextPassAt: new Date("2026-07-11T18:30:00Z"),
    }, "Europe/Moscow");
    expect(text).toContain("покрытие залива 46% при требуемых 70%");
    expect(text).toContain("11.07, 21:30 МСК");
  });

  it("explicitly says when pass prediction is unavailable", () => {
    const text = formatDetailedSatelliteSkip({
      status: "skipped",
      reason: { code: "source-unavailable" },
      nextPassAt: null,
    }, "Europe/Moscow");
    expect(text).toContain("источник снимков временно недоступен");
    expect(text).toContain("определить не удалось");
  });

  it("includes the actual image age and configured limit", () => {
    const text = formatDetailedSatelliteSkip({
      status: "skipped",
      reason: { code: "stale", ageHours: 19, maxAgeHours: 12 },
      nextPassAt: null,
    }, "Europe/Moscow");
    expect(text).toContain("последнему снимку 19 ч при допустимых 12 ч");
  });
});
