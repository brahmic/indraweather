import { access, readFile, rename, rm, stat } from "node:fs/promises";
import type { AnimationAttachment } from "../delivery/types.js";
import type {
  CloudAnimationFrameRecord,
  Database,
  SatelliteCaptureJobRecord,
} from "../infrastructure/database.js";
import type { Logger } from "../logger.js";
import type { CloudAnimationMode, CloudDiagnosticService } from "./cloud-diagnostic-service.js";
import type { CoastlineOverlayService } from "./coastline-overlay-service.js";
import type { WindOverlayService } from "./wind-overlay-service.js";
import {
  AnimationStore,
  FfmpegAnimationEncoder,
  stampAnimationFrame,
} from "./satellite-animation-service.js";

export interface CloudAnimationOptions {
  intervalMinutes: number;
  windowHours: number;
  retentionHours: number;
  minFrames: number;
  directory: string;
  maxBytes: number;
  timeZone: string;
}

interface AnimationEncoder {
  encode(framePaths: string[], outputPath: string): Promise<void>;
}

export class CloudAnimationService {
  private worker: Promise<void> | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private rendering: Promise<AnimationAttachment | null> | null = null;

  constructor(
    private readonly database: Database,
    private readonly clouds: CloudDiagnosticService,
    private readonly mapContext: CoastlineOverlayService,
    private readonly windOverlay: WindOverlayService,
    private readonly store: AnimationStore,
    private readonly options: CloudAnimationOptions,
    private readonly logger: Logger,
    private readonly encoder: AnimationEncoder = new FfmpegAnimationEncoder(),
  ) {}

  async start(): Promise<void> {
    await this.store.initialize();
    await this.database.resetProcessingCloudAnimationCaptureJobs();
    this.queueTimer = setInterval(() => this.kick(), 15_000);
    await this.enqueueCurrentSlot();
    this.scheduleNextCapture();
  }

  async stop(): Promise<void> {
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.queueTimer = null;
    this.scheduleTimer = null;
    await this.worker;
  }

  async getLatest(): Promise<AnimationAttachment | null> {
    if (this.rendering) return this.rendering;
    this.rendering = this.render().finally(() => {
      this.rendering = null;
    });
    return this.rendering;
  }

  private async enqueueCurrentSlot(): Promise<void> {
    const scheduledFor = floorToInterval(new Date(), this.options.intervalMinutes);
    if (await this.database.enqueueCloudAnimationCaptureJob(scheduledFor)) this.kick();
  }

  private scheduleNextCapture(): void {
    const intervalMs = this.options.intervalMinutes * 60_000;
    const delay = intervalMs - (Date.now() % intervalMs) + 100;
    this.scheduleTimer = setTimeout(() => {
      this.enqueueCurrentSlot().catch((error: unknown) =>
        this.logger.error({ error }, "Cloud animation capture job enqueue failed"));
      this.scheduleNextCapture();
    }, delay);
  }

  private kick(): void {
    if (this.worker) return;
    this.worker = this.processQueue()
      .catch((error: unknown) => this.logger.error({ error }, "Cloud animation capture worker failed"))
      .finally(() => {
        this.worker = null;
      });
  }

  private async processQueue(): Promise<void> {
    let job: SatelliteCaptureJobRecord | null;
    while ((job = await this.database.claimCloudAnimationCaptureJob())) {
      try {
        await this.capture(job);
        await this.database.completeCloudAnimationCaptureJob(job.scheduledFor);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.database.failCloudAnimationCaptureJob(job.scheduledFor, message, job.attempts);
        this.logger.warn({ error, scheduledFor: job.scheduledFor }, "Cloud animation capture failed");
      }
    }
  }

  private async capture(job: SatelliteCaptureJobRecord): Promise<void> {
    const frame = await this.clouds.getLatestForAnimation();
    const filename = `frame-${frame.mode}-${fileTime(frame.attachment.observedAt)}.png`;
    await this.store.write(filename, frame.attachment.data);
    const inserted = await this.database.saveCloudAnimationFrame(
      frame.attachment.observedAt,
      frame.mode,
      filename,
      frame.attachment.data.byteLength,
      frame.attachment.source,
    );
    await this.cleanup();
    if (inserted) {
      this.logger.info(
        { observedAt: frame.attachment.observedAt, mode: frame.mode, filename },
        "Cloud animation frame stored",
      );
      await this.getLatest().catch((error: unknown) =>
        this.logger.warn({ error }, "Cloud animation render deferred"));
    }
  }

  private async render(): Promise<AnimationAttachment | null> {
    const now = new Date();
    const mode = this.clouds.getAnimationMode(now);
    const frames = await this.database.getCloudAnimationFrames(
      new Date(now.getTime() - this.options.windowHours * 3_600_000),
      mode,
    );
    const ready = await this.store.existing(frames);
    if (ready.length < this.options.minFrames) return null;

    const first = ready[0];
    const last = ready.at(-1);
    if (!first || !last) return null;
    const filename = `cloud-animation-v1-${mode}-${fileTime(first.observedAt)}-${fileTime(last.observedAt)}-${ready.length}.mp4`;
    const outputPath = this.store.path(filename);
    if (!await fileExists(outputPath)) {
      const temporaryPath = this.store.path(`.${filename}.tmp.mp4`);
      const stamped = await this.createStampedFrames(filename, ready, mode);
      try {
        await this.encoder.encode(stamped.paths, temporaryPath);
      } finally {
        await Promise.all(stamped.filenames.map((name) => this.store.remove(name)));
      }
      const output = await stat(temporaryPath);
      if (output.size > this.options.maxBytes) {
        await rm(temporaryPath, { force: true });
        throw new Error(`Cloud animation exceeds ${this.options.maxBytes} bytes`);
      }
      await rename(temporaryPath, outputPath);
    }
    const data = await readFile(outputPath);
    return {
      kind: "animation",
      data,
      contentType: "video/mp4",
      filename,
      caption: animationCaption(first.observedAt, last.observedAt, ready.length, mode, this.options.timeZone),
      source: first.source,
      startedAt: first.observedAt,
      endedAt: last.observedAt,
      frameCount: ready.length,
    };
  }

  private async cleanup(): Promise<void> {
    const before = new Date(Date.now() - this.options.retentionHours * 3_600_000);
    const expired = await this.database.removeExpiredCloudAnimationFrames(before);
    await Promise.all(expired.map((filename) => this.store.remove(filename)));
    await this.database.removeExpiredCloudAnimationCaptureJobs(before);
    await this.store.removeOldAnimations(before);
  }

  private async createStampedFrames(
    animationFilename: string,
    frames: CloudAnimationFrameRecord[],
    mode: CloudAnimationMode,
  ): Promise<{ paths: string[]; filenames: string[] }> {
    const filenames = frames.map((_, index) => `.${animationFilename}.${index}.png`);
    await Promise.all(frames.map(async (frame, index) => {
      const filename = filenames[index];
      if (!filename) throw new Error("Cloud animation frame filename is missing");
      const source = await readFile(this.store.path(frame.filename));
      const stamped = await stampAnimationFrame(
        source,
        frame.observedAt,
        this.options.timeZone,
        frameLabel(mode),
        index === frames.length - 1,
      );
      const mapped = await this.mapContext.applyContext(stamped);
      const data = index === frames.length - 1
        ? await this.windOverlay.apply(mapped, frame.observedAt, { headerTop: 56 })
        : mapped;
      await this.store.write(filename, data);
    }));
    return { filenames, paths: filenames.map((filename) => this.store.path(filename)) };
  }
}

function floorToInterval(date: Date, intervalMinutes: number): Date {
  const intervalMs = intervalMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
}

function fileTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}

function frameLabel(mode: CloudAnimationMode): string {
  return mode === "cloudtype" ? "EUMETSAT · типы облаков" : "EUMETSAT · туман и низкая облачность";
}

function animationCaption(
  startedAt: Date,
  endedAt: Date,
  frameCount: number,
  mode: CloudAnimationMode,
  timeZone: string,
): string {
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const durationMinutes = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000));
  const duration = durationMinutes >= 60
    ? `${Math.floor(durationMinutes / 60)} ч ${durationMinutes % 60} мин`
    : `${durationMinutes} мин`;
  const title = mode === "cloudtype" ? "типы облаков" : "туман и низкая облачность";
  return [
    `Кемь - Кандалакша · ${title} · движение`,
    `${formatter.format(startedAt)} - ${formatter.format(endedAt)} МСК · ${duration} · ${frameCount} кадров`,
    "Источник: EUMETSAT EUMETView",
  ].join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
