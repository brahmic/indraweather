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
  it("returns an LI lightning map only when the service is configured", async () => {
    const image = { kind: "image", filename: "lightning.png" } as never;
    const lightning = { getLatest: vi.fn(async () => image) };
    const service = new PublicationService(
      {} as never,
      null, null, null, null, null, null, null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow", { warn: () => undefined } as never,
      lightning as never,
    );
    const viewport = { bbox: [30, 64, 36, 68] as [number, number, number, number], width: 1_000, height: 800 };

    await expect(service.getLightning(viewport)).resolves.toBe(image);
    expect(lightning.getLatest).toHaveBeenCalledWith(viewport);

    const disabled = new PublicationService(
      {} as never,
      null, null, null, null, null, null, null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow", { warn: () => undefined } as never,
    );
    await expect(disabled.getLightning()).rejects.toThrow(/not configured/u);
  });

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

  it("returns cloud diagnostics, infrared, and an available detailed bay image", async () => {
    const image = { kind: "image", filename: "clouds.png" } as never;
    const infrared = { kind: "image", filename: "infrared.png" } as never;
    const detailed = { kind: "image", filename: "sentinel-3.png" } as never;
    const cloudAnimation = { getLatest: vi.fn() };
    const service = new PublicationService(
      {} as never,
      { getLatestInfraredSnapshot: async () => infrared } as never,
      null,
      { getLatest: async () => ({ status: "available", attachment: detailed }) } as never,
      { getLatest: async () => image } as never,
      cloudAnimation as never,
      null,
      null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      { warn: () => undefined } as never,
    );

    await expect(service.getClouds()).resolves.toEqual([image, infrared, detailed]);
    expect(cloudAnimation.getLatest).not.toHaveBeenCalled();
  });

  it("omits a skipped detailed bay image without changing the static cloud response", async () => {
    const image = { kind: "image", filename: "clouds.png" } as never;
    const infrared = { kind: "image", filename: "infrared.png" } as never;
    const service = new PublicationService(
      {} as never,
      { getLatestInfraredSnapshot: async () => infrared } as never,
      null,
      { getLatest: async () => ({ status: "skipped", reason: { code: "stale" } }) } as never,
      { getLatest: async () => image } as never,
      null,
      null,
      null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      { warn: () => undefined } as never,
    );

    await expect(service.getClouds()).resolves.toEqual([image, infrared]);
  });

  it("adds the model map to the main bulletin and keeps details text-only", async () => {
    const createdAt = new Date("2026-07-13T09:00:00Z");
    const map = { kind: "image", filename: "forecast-map.png" } as never;
    const forecastMap = { get: vi.fn(async () => map) };
    const service = new PublicationService(
      {
        getFreshOrRun: async () => ({
          id: "bulletin-1",
          runId: "run-1",
          content: "weather",
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
    expect(details).not.toHaveProperty("attachments");
    expect(forecastMap.get).not.toHaveBeenCalled();

    const bulletin = await service.getFreshOrRun();

    expect(bulletin.attachments).toEqual([map]);
    expect(forecastMap.get).toHaveBeenCalledWith("run-1", createdAt, undefined);
  });

  it("uses the recipient viewport for every bulletin map", async () => {
    const createdAt = new Date("2026-07-13T09:00:00Z");
    const map = { kind: "image", filename: "forecast-map.png" } as never;
    const forecastMap = { get: vi.fn(async () => map) };
    const service = new PublicationService(
      {
        getFreshOrRun: async () => ({
          id: "bulletin-1", runId: "run-1", content: "weather", contentFormat: "plain",
          summary: {}, createdAt,
        }),
      } as never,
      null, null, null, null, null, null, forecastMap as never,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow", { warn: () => undefined } as never,
    );
    const viewport = {
      bbox: [32, 65, 34, 67] as [number, number, number, number],
      width: 900,
      height: 700,
    };

    await service.getFreshOrRun(viewport);

    expect(forecastMap.get).toHaveBeenCalledWith("run-1", createdAt, viewport);
  });

  it("returns the current model map for the forecast picker without bulletin imagery", async () => {
    const createdAt = new Date("2026-07-13T09:00:00Z");
    const map = { kind: "image", filename: "forecast-map.png" } as never;
    const forecastMap = { get: vi.fn(async () => map) };
    const bulletins = {
      getFreshOrRun: vi.fn(async () => ({
        id: "bulletin-1", runId: "run-1", content: "weather", contentFormat: "plain",
        summary: {}, createdAt,
      })),
    };
    const service = new PublicationService(
      bulletins as never,
      null, null, null, null, null, null, forecastMap as never,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow", { warn: () => undefined } as never,
    );
    const viewport = {
      bbox: [32, 65, 34, 67] as [number, number, number, number],
      width: 900,
      height: 700,
    };

    await expect(service.getForecastMap(viewport)).resolves.toBe(map);

    expect(forecastMap.get).toHaveBeenCalledWith("run-1", createdAt, viewport);
  });

  it("rebuilds a stored bulletin for durable delivery retry", async () => {
    const createdAt = new Date("2026-07-13T09:00:00Z");
    const bulletins = {
      getStored: vi.fn(async () => ({
        id: "bulletin-1", runId: "run-1", content: "weather", contentFormat: "plain",
        summary: {}, createdAt,
      })),
    };
    const service = new PublicationService(
      bulletins as never,
      null, null, null, null, null, null, null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow", { warn: () => undefined } as never,
    );

    await expect(service.getStored("bulletin-1")).resolves.toMatchObject({
      id: "bulletin-1", text: "weather", attachments: [],
    });
  });

  it("orders overview, detailed Sentinel-3, and model map in a bulletin album", async () => {
    const createdAt = new Date("2026-07-13T09:00:00Z");
    const overview = { kind: "image", filename: "overview.png" } as never;
    const detail = { kind: "image", filename: "detail.png" } as never;
    const map = { kind: "image", filename: "forecast.png" } as never;
    const service = new PublicationService(
      {
        getFreshOrRun: async () => ({
          id: "bulletin-1",
          runId: "run-1",
          content: "weather",
          contentFormat: "plain",
          summary: {},
          createdAt,
        }),
      } as never,
      { getLatest: async () => overview } as never,
      null,
      {
        getLatest: async () => ({
          status: "available",
          attachment: detail,
          coveragePercent: 100,
          partial: null,
        }),
      } as never,
      null,
      null,
      null,
      { get: async () => map } as never,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      { warn: () => undefined } as never,
    );

    const publication = await service.getFreshOrRun();

    expect(publication.attachments).toEqual([overview, detail, map]);
  });

  it("keeps animations out of regular bulletins and exposes cloud motion on demand", async () => {
    const infraredAnimation = { kind: "animation", filename: "infrared.mp4" } as never;
    const diagnosticAnimation = { kind: "animation", filename: "diagnostic.mp4" } as never;
    const satelliteAnimation = { getLatest: vi.fn(async () => infraredAnimation) };
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
      satelliteAnimation as never,
      null,
      null,
      { getLatest: vi.fn(async () => diagnosticAnimation) } as never,
      null,
      null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      { warn: () => undefined } as never,
    );

    await expect(service.getFreshOrRun()).resolves.toMatchObject({ attachments: [] });
    await expect(service.getCloudMotionAnimations()).resolves.toEqual([
      infraredAnimation,
      diagnosticAnimation,
    ]);
    expect(satelliteAnimation.getLatest).toHaveBeenCalledOnce();
  });

  it("returns the infrared animation when the diagnostic series is not ready", async () => {
    const infraredAnimation = { kind: "animation", filename: "infrared.mp4" } as never;
    const logger = { warn: vi.fn() };
    const service = new PublicationService(
      {} as never,
      null,
      { getLatest: async () => infraredAnimation } as never,
      null,
      null,
      { getLatest: async () => null } as never,
      null,
      null,
      { get: async () => "point forecast" } as never,
      "Europe/Moscow",
      logger as never,
    );

    await expect(service.getCloudMotionAnimations()).resolves.toEqual([infraredAnimation]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
