import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SatelliteAnimationService,
  SatelliteAnimationStore,
} from "../src/application/satellite-animation-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SatelliteAnimationService", () => {
  it("builds one bounded MP4 from the available rolling frames", async () => {
    const directory = await temporaryDirectory();
    const store = new SatelliteAnimationStore(directory);
    await store.initialize();
    const now = Date.now();
    const frames = [0, 20, 40].map((minutes, index) => ({
      observedAt: new Date(now - (40 - minutes) * 60_000),
      filename: `frame-${index}.png`,
      byteSize: 4,
      source: "EUMETSAT EUMETView",
    }));
    const image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#234567" },
    }).png().toBuffer();
    await Promise.all(frames.map((frame) => store.write(frame.filename, image)));
    const encoder = {
      encode: vi.fn(async (_paths: string[], output: string) => writeFile(output, new Uint8Array([0, 1, 2]))),
    };
    const mapContext = { applyContext: vi.fn(async (image: Uint8Array) => image) };
    const windOverlay = { apply: vi.fn(async (image: Uint8Array) => image) };
    const service = createService(store, frames, encoder, mapContext, windOverlay);

    const animation = await service.getLatest();

    expect(animation).toMatchObject({
      kind: "animation",
      contentType: "video/mp4",
      frameCount: 3,
      source: "EUMETSAT EUMETView",
    });
    expect(animation?.caption).toContain("3 кадров");
    expect(encoder.encode).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining(".png")]),
      expect.stringContaining(".tmp.mp4"),
    );
    expect((encoder.encode.mock.calls[0]?.[0] as string[]).length).toBe(3);
    expect(mapContext.applyContext).toHaveBeenCalledTimes(3);
    expect(windOverlay.apply).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      frames[2]?.observedAt,
      { headerTop: 56 },
    );
  });

  it("waits for the minimum number of successful frames", async () => {
    const directory = await temporaryDirectory();
    const store = new SatelliteAnimationStore(directory);
    await store.initialize();
    const service = createService(store, [], { encode: vi.fn() });

    await expect(service.getLatest()).resolves.toBeNull();
  });

  it("collects infrared frames through the durable capture queue", async () => {
    const directory = await temporaryDirectory();
    const store = new SatelliteAnimationStore(directory);
    const observedAt = new Date();
    const database = {
      resetProcessingSatelliteCaptureJobs: vi.fn(async () => undefined),
      enqueueSatelliteCaptureJob: vi.fn(async () => true),
      claimSatelliteCaptureJob: vi.fn()
        .mockResolvedValueOnce({ scheduledFor: new Date(), attempts: 1 })
        .mockResolvedValueOnce(null),
      saveSatelliteAnimationFrame: vi.fn(async () => true),
      completeSatelliteCaptureJob: vi.fn(async () => undefined),
      failSatelliteCaptureJob: vi.fn(async () => undefined),
      getSatelliteAnimationFrames: vi.fn(async () => []),
      removeExpiredSatelliteAnimationFrames: vi.fn(async () => []),
      removeExpiredSatelliteCaptureJobs: vi.fn(async () => undefined),
    };
    const satellite = {
      getLatestInfrared: vi.fn(async () => ({
        kind: "image" as const,
        data: new Uint8Array([1, 2, 3, 4]),
        contentType: "image/png" as const,
        filename: "infrared.png",
        caption: "Infrared",
        source: "EUMETSAT EUMETView",
        observedAt,
      })),
    };
    const service = new SatelliteAnimationService(
      database as never,
      satellite,
      { applyContext: vi.fn(async (image: Uint8Array) => image) },
      { apply: vi.fn(async (image: Uint8Array) => image) },
      store,
      options(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { encode: vi.fn() },
    );

    await service.start();
    await vi.waitFor(() => expect(database.completeSatelliteCaptureJob).toHaveBeenCalledOnce());
    await service.stop();

    expect(satellite.getLatestInfrared).toHaveBeenCalledOnce();
    expect(database.saveSatelliteAnimationFrame).toHaveBeenCalledWith(
      observedAt,
      expect.stringMatching(/^frame-.*\.png$/u),
      4,
      "EUMETSAT EUMETView",
    );
  });
});

function createService(
  store: SatelliteAnimationStore,
  frames: Array<{ observedAt: Date; filename: string; byteSize: number; source: string }>,
  encoder: { encode(framePaths: string[], outputPath: string): Promise<void> },
  mapContext = { applyContext: vi.fn(async (image: Uint8Array) => image) },
  windOverlay = { apply: vi.fn(async (image: Uint8Array) => image) },
) {
  return new SatelliteAnimationService(
    {
      getSatelliteAnimationFrames: vi.fn(async () => frames),
    } as never,
    { getLatestInfrared: vi.fn() },
    mapContext,
    windOverlay,
    store,
    options(),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    encoder,
  );
}

function options() {
  return {
    intervalMinutes: 20,
    windowHours: 24,
    retentionHours: 26,
    minFrames: 3,
    directory: "unused",
    maxBytes: 100,
    timeZone: "Europe/Moscow",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "indra-satellite-animation-"));
  directories.push(directory);
  return directory;
}
