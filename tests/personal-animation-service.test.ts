import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalAnimationService } from "../src/application/personal-animation-service.js";
import { AnimationStore } from "../src/application/satellite-animation-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PersonalAnimationService", () => {
  it("renders and delivers a custom satellite animation through the background queue", async () => {
    const directory = await temporaryDirectory();
    const store = new AnimationStore(directory);
    await store.initialize();
    const now = Date.now();
    const frames = [0, 20, 40].map((minutes) => ({
      observedAt: new Date(now - (40 - minutes) * 60_000),
      source: "EUMETSAT EUMETView",
      label: "EUMETSAT ИК",
    }));
    const job = personalJob();
    const database = {
      getCachedPersonalAnimation: vi.fn(async () => null),
      enqueuePersonalAnimation: vi.fn(async () => job),
      claimPersonalAnimation: vi.fn()
        .mockResolvedValueOnce({ ...job, attempts: 1 })
        .mockResolvedValueOnce(null),
      isMapViewportCurrent: vi.fn(async () => true),
      completePersonalAnimation: vi.fn(async () => undefined),
      failPersonalAnimation: vi.fn(async () => undefined),
      removeExpiredPersonalAnimations: vi.fn(async () => []),
    };
    const png = new Uint8Array(await sharp({
      create: { width: 32, height: 24, channels: 3, background: "#234567" },
    }).png().toBuffer());
    const getFrame = vi.fn(async (frame: { observedAt: Date }) => ({
      kind: "image" as const,
      data: png,
      contentType: "image/png" as const,
      filename: "frame.png",
      caption: "Frame",
      source: "EUMETSAT EUMETView",
      observedAt: frame.observedAt,
    }));
    const source = {
      kind: "satellite" as const,
      getContext: vi.fn(() => "infrared"),
      getFrames: vi.fn(async () => frames),
      createFrameFetcher: vi.fn(async () => getFrame),
    };
    const encoder = {
      encode: vi.fn(async (_paths: string[], output: string) => writeFile(output, new Uint8Array([0, 1, 2]))),
    };
    const delivery = vi.fn(async () => undefined);
    const service = new PersonalAnimationService(
      database as never,
      [source],
      { withViewport: () => ({ applyContext: async (image: Uint8Array) => image }) } as never,
      { withViewport: () => ({ apply: async (image: Uint8Array) => image }) } as never,
      store,
      options(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      encoder,
    );
    service.setDelivery("telegram", delivery);

    await expect(service.request("telegram", "123", "satellite", viewport())).resolves.toBe("queued");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());

    expect(source.createFrameFetcher).toHaveBeenCalledOnce();
    expect(getFrame).toHaveBeenCalledTimes(3);
    expect(encoder.encode).toHaveBeenCalledOnce();
    expect(database.completePersonalAnimation).toHaveBeenCalledWith(
      job.id,
      expect.stringMatching(/^personal-satellite-77-.*\.mp4$/u),
      "EUMETSAT EUMETView",
      frames[0]?.observedAt,
      frames[2]?.observedAt,
      3,
    );
  });

  it("delivers a recent cached animation without requesting frames again", async () => {
    const directory = await temporaryDirectory();
    const store = new AnimationStore(directory);
    await store.initialize();
    const job = {
      ...personalJob(),
      outputFilename: "personal-satellite-77.mp4",
      source: "EUMETSAT EUMETView",
      startedAt: new Date("2026-07-12T08:00:00Z"),
      endedAt: new Date("2026-07-12T10:00:00Z"),
      frameCount: 3,
    };
    await store.write(job.outputFilename, new Uint8Array([0, 1, 2]));
    const database = {
      getCachedPersonalAnimation: vi.fn(async () => job),
      isMapViewportCurrent: vi.fn(async () => true),
    };
    const source = {
      kind: "satellite" as const,
      getContext: vi.fn(() => "infrared"),
      getFrames: vi.fn(),
      createFrameFetcher: vi.fn(),
    };
    const delivery = vi.fn(async () => undefined);
    const service = new PersonalAnimationService(
      database as never,
      [source],
      {} as never,
      {} as never,
      store,
      options(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    );
    service.setDelivery("telegram", delivery);

    await expect(service.request("telegram", "123", "satellite", viewport())).resolves.toBe("cached");
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());

    expect(source.getFrames).not.toHaveBeenCalled();
  });

  it("cancels a job when the user changes the map before rendering", async () => {
    const job = personalJob();
    const database = {
      getCachedPersonalAnimation: vi.fn(async () => null),
      enqueuePersonalAnimation: vi.fn(async () => job),
      claimPersonalAnimation: vi.fn()
        .mockResolvedValueOnce({ ...job, attempts: 1 })
        .mockResolvedValueOnce(null),
      isMapViewportCurrent: vi.fn(async () => false),
      cancelPersonalAnimation: vi.fn(async () => undefined),
    };
    const source = {
      kind: "satellite" as const,
      getContext: vi.fn(() => "infrared"),
      getFrames: vi.fn(async () => [
        { observedAt: new Date(), source: "EUMETSAT", label: "EUMETSAT ИК" },
        { observedAt: new Date(), source: "EUMETSAT", label: "EUMETSAT ИК" },
        { observedAt: new Date(), source: "EUMETSAT", label: "EUMETSAT ИК" },
      ]),
      createFrameFetcher: vi.fn(),
    };
    const service = new PersonalAnimationService(
      database as never,
      [source],
      {} as never,
      {} as never,
      {} as never,
      options(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    );
    const delivery = vi.fn(async () => undefined);
    service.setDelivery("telegram", delivery);

    await expect(service.request("telegram", "123", "satellite", viewport())).resolves.toBe("queued");
    await vi.waitFor(() => expect(database.cancelPersonalAnimation).toHaveBeenCalledWith(job.id));

    expect(source.createFrameFetcher).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
  });
});

function viewport() {
  return { bbox: [30, 64, 36, 68] as [number, number, number, number], width: 1000, height: 800 };
}

function personalJob() {
  return {
    id: 77,
    channel: "telegram",
    recipientId: "123",
    kind: "satellite" as const,
    viewportKey: "30,64,36,68:1000x800",
    context: "infrared",
    bbox: [30, 64, 36, 68] as [number, number, number, number],
    width: 1000,
    height: 800,
    attempts: 0,
    outputFilename: null,
    source: null,
    startedAt: null,
    endedAt: null,
    frameCount: null,
  };
}

function options() {
  return {
    windowHours: 12,
    retentionHours: 26,
    minFrames: 3,
    maxBytes: 100,
    cacheMinutes: 20,
    timeZone: "Europe/Moscow",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "indra-personal-animation-"));
  directories.push(directory);
  return directory;
}
