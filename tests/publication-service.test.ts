import { describe, expect, it, vi } from "vitest";
import {
  formatDetailedSatellitePartial,
  formatDetailedSatelliteSkip,
  PublicationService,
} from "../src/application/publication-service.js";

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

describe("formatDetailedSatellitePartial", () => {
  it("explains the incomplete coverage and the next expected pass", () => {
    const text = formatDetailedSatellitePartial({
      status: "available",
      coveragePercent: 28,
      attachment: {} as never,
      partial: {
        preferredCoveragePercent: 70,
        nextPassAt: new Date("2026-07-11T18:30:00Z"),
      },
    }, "Europe/Moscow");
    expect(text).toContain("данные есть только для части залива");
    expect(text).toContain("покрытие 28% при желательном 70%");
    expect(text).toContain("11.07, 21:30 МСК");
  });
});

describe("PublicationService", () => {
  it("leaves detail actions to delivery channels", async () => {
    const service = new PublicationService(
      {
        getFreshOrRun: async () => ({
          id: "bulletin-1",
          content: "weather",
          contentFormat: "plain",
          summary: {},
          createdAt: new Date(),
        }),
      } as never,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      { warn: () => undefined } as never,
    );

    const publication = await service.getFreshOrRun();

    expect(publication.text).toBe("weather");
    expect(publication.text).not.toContain("/details");
  });

  it("returns the current cloud diagnostic together with its separate animation", async () => {
    const image = { kind: "image", filename: "clouds.png" } as never;
    const animation = { kind: "animation", filename: "clouds.mp4" } as never;
    const service = new PublicationService(
      {} as never,
      null,
      null,
      null,
      { getLatest: async () => image } as never,
      { getLatest: async () => animation } as never,
      null,
      null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      { warn: () => undefined } as never,
    );

    await expect(service.getClouds()).resolves.toEqual([image, animation]);
  });

  it("adds the model map to details without changing the main bulletin", async () => {
    const createdAt = new Date("2026-07-13T09:00:00Z");
    const map = { kind: "image", filename: "forecast-map.png" } as never;
    const forecastMap = { get: vi.fn(async () => map) };
    const service = new PublicationService(
      {
        getFreshOrRun: async () => ({
          id: "bulletin-1",
          runId: "run-1",
          summary: {
            generatedAt: createdAt.toISOString(),
            horizonHours: 24,
            pointSummaries: [],
            agreement: { agreed: true, reasons: [] },
          },
          createdAt,
        }),
      } as never,
      null,
      null,
      null,
      null,
      null,
      null,
      forecastMap as never,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      { warn: () => undefined } as never,
    );

    const details = await service.getFreshDetails();

    expect(details.text).toContain("Детализация по моделям");
    expect(details.attachments).toEqual([map]);
    expect(forecastMap.get).toHaveBeenCalledWith("run-1", createdAt);
  });
});
