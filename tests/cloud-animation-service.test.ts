import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAnimationService } from "../src/application/cloud-animation-service.js";
import { AnimationStore } from "../src/application/satellite-animation-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CloudAnimationService", () => {
  it("builds a cloud-type MP4 only from frames in the active diagnostic mode", async () => {
    const directory = await temporaryDirectory();
    const store = new AnimationStore(directory);
    await store.initialize();
    const now = Date.now();
    const frames = [0, 20, 40].map((minutes, index) => ({
      mode: "cloudtype" as const,
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
    const database = {
      getCloudAnimationFrames: vi.fn(async () => frames),
    };
    const clouds = {
      getAnimationMode: vi.fn(() => "cloudtype" as const),
    };
    const mapContext = { applyContext: vi.fn(async (data: Uint8Array) => data) };
    const service = new CloudAnimationService(
      database as never,
      clouds as never,
      mapContext as never,
      store,
      options(),
      logger(),
      encoder,
    );

    const animation = await service.getLatest();

    expect(animation).toMatchObject({
      kind: "animation",
      contentType: "video/mp4",
      frameCount: 3,
    });
    expect(animation?.caption).toContain("типы облаков · движение");
    expect(database.getCloudAnimationFrames).toHaveBeenCalledWith(expect.any(Date), "cloudtype");
    expect(mapContext.applyContext).toHaveBeenCalledTimes(3);
  });

  it("collects the active daytime or nighttime layer through its own durable queue", async () => {
    const directory = await temporaryDirectory();
    const store = new AnimationStore(directory);
    const observedAt = new Date();
    const database = {
      resetProcessingCloudAnimationCaptureJobs: vi.fn(async () => undefined),
      enqueueCloudAnimationCaptureJob: vi.fn(async () => true),
      claimCloudAnimationCaptureJob: vi.fn()
        .mockResolvedValueOnce({ scheduledFor: new Date(), attempts: 1 })
        .mockResolvedValueOnce(null),
      saveCloudAnimationFrame: vi.fn(async () => true),
      completeCloudAnimationCaptureJob: vi.fn(async () => undefined),
      failCloudAnimationCaptureJob: vi.fn(async () => undefined),
      getCloudAnimationFrames: vi.fn(async () => []),
      removeExpiredCloudAnimationFrames: vi.fn(async () => []),
      removeExpiredCloudAnimationCaptureJobs: vi.fn(async () => undefined),
    };
    const clouds = {
      getLatestForAnimation: vi.fn(async () => ({
        mode: "fog" as const,
        attachment: {
          kind: "image" as const,
          data: new Uint8Array([1, 2, 3, 4]),
          contentType: "image/png" as const,
          filename: "clouds-fog.png",
          caption: "Fog",
          source: "EUMETSAT EUMETView",
          observedAt,
        },
      })),
      getAnimationMode: vi.fn(() => "fog" as const),
    };
    const service = new CloudAnimationService(
      database as never,
      clouds as never,
      { applyContext: vi.fn(async (data: Uint8Array) => data) } as never,
      store,
      options(),
      logger(),
      { encode: vi.fn() },
    );

    await service.start();
    await vi.waitFor(() => expect(database.completeCloudAnimationCaptureJob).toHaveBeenCalledOnce());
    await service.stop();

    expect(clouds.getLatestForAnimation).toHaveBeenCalledOnce();
    expect(database.saveCloudAnimationFrame).toHaveBeenCalledWith(
      observedAt,
      "fog",
      expect.stringMatching(/^frame-fog-.*\.png$/u),
      4,
      "EUMETSAT EUMETView",
    );
  });
});

function options() {
  return {
    intervalMinutes: 20,
    windowHours: 12,
    retentionHours: 26,
    minFrames: 3,
    directory: "unused",
    maxBytes: 100,
    timeZone: "Europe/Moscow",
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "indra-cloud-animation-"));
  directories.push(directory);
  return directory;
}
