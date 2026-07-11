import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import sharp from "sharp";
import type { AnimationAttachment, ImageAttachment } from "../delivery/types.js";
import type {
  Database,
  SatelliteAnimationFrameRecord,
  SatelliteCaptureJobRecord,
} from "../infrastructure/database.js";
import type { Logger } from "../logger.js";

const execFileAsync = promisify(execFile);
const FRAME_DURATION_SECONDS = 0.15;

export interface SatelliteAnimationOptions {
  intervalMinutes: number;
  windowHours: number;
  retentionHours: number;
  minFrames: number;
  directory: string;
  maxBytes: number;
  timeZone: string;
}

interface InfraredImageSource {
  getLatestInfrared(now?: Date): Promise<ImageAttachment>;
}

interface AnimationEncoder {
  encode(framePaths: string[], outputPath: string): Promise<void>;
}

export class SatelliteAnimationService {
  private worker: Promise<void> | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private rendering: Promise<AnimationAttachment | null> | null = null;

  constructor(
    private readonly database: Database,
    private readonly satellite: InfraredImageSource,
    private readonly store: SatelliteAnimationStore,
    private readonly options: SatelliteAnimationOptions,
    private readonly logger: Logger,
    private readonly encoder: AnimationEncoder = new FfmpegAnimationEncoder(),
  ) {}

  async start(): Promise<void> {
    await this.store.initialize();
    await this.database.resetProcessingSatelliteCaptureJobs();
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
    if (await this.database.enqueueSatelliteCaptureJob(scheduledFor)) this.kick();
  }

  private scheduleNextCapture(): void {
    const intervalMs = this.options.intervalMinutes * 60_000;
    const delay = intervalMs - (Date.now() % intervalMs) + 100;
    this.scheduleTimer = setTimeout(() => {
      this.enqueueCurrentSlot().catch((error: unknown) =>
        this.logger.error({ error }, "Satellite capture job enqueue failed"));
      this.scheduleNextCapture();
    }, delay);
  }

  private kick(): void {
    if (this.worker) return;
    this.worker = this.processQueue()
      .catch((error: unknown) => this.logger.error({ error }, "Satellite capture worker failed"))
      .finally(() => {
        this.worker = null;
      });
  }

  private async processQueue(): Promise<void> {
    let job: SatelliteCaptureJobRecord | null;
    while ((job = await this.database.claimSatelliteCaptureJob())) {
      try {
        await this.capture(job);
        await this.database.completeSatelliteCaptureJob(job.scheduledFor);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.database.failSatelliteCaptureJob(job.scheduledFor, message, job.attempts);
        this.logger.warn({ error, scheduledFor: job.scheduledFor }, "Satellite capture failed");
      }
    }
  }

  private async capture(job: SatelliteCaptureJobRecord): Promise<void> {
    const frame = await this.satellite.getLatestInfrared(job.scheduledFor);
    const filename = `frame-${fileTime(frame.observedAt)}.png`;
    await this.store.write(filename, frame.data);
    const inserted = await this.database.saveSatelliteAnimationFrame(
      frame.observedAt,
      filename,
      frame.data.byteLength,
      frame.source,
    );
    await this.cleanup();
    if (inserted) {
      this.logger.info({ observedAt: frame.observedAt, filename }, "Satellite animation frame stored");
      await this.getLatest().catch((error: unknown) =>
        this.logger.warn({ error }, "Satellite animation render deferred"));
    }
  }

  private async render(): Promise<AnimationAttachment | null> {
    const now = new Date();
    const frames = await this.database.getSatelliteAnimationFrames(
      new Date(now.getTime() - this.options.windowHours * 3_600_000),
    );
    const ready = await this.store.existing(frames);
    if (ready.length < this.options.minFrames) return null;

    const first = ready[0];
    const last = ready.at(-1);
    if (!first || !last) return null;
    const filename = `animation-v3-${fileTime(first.observedAt)}-${fileTime(last.observedAt)}-${ready.length}.mp4`;
    const outputPath = this.store.path(filename);
    if (!await fileExists(outputPath)) {
      const temporaryPath = this.store.path(`.${filename}.tmp.mp4`);
      const stamped = await this.createStampedFrames(filename, ready);
      try {
        await this.encoder.encode(stamped.paths, temporaryPath);
      } finally {
        await Promise.all(stamped.filenames.map((name) => this.store.remove(name)));
      }
      const output = await stat(temporaryPath);
      if (output.size > this.options.maxBytes) {
        await rm(temporaryPath, { force: true });
        throw new Error(`Satellite animation exceeds ${this.options.maxBytes} bytes`);
      }
      await rename(temporaryPath, outputPath);
    }
    const data = await readFile(outputPath);
    return {
      kind: "animation",
      data,
      contentType: "video/mp4",
      filename,
      caption: animationCaption(first.observedAt, last.observedAt, ready.length, this.options.timeZone),
      source: first.source,
      startedAt: first.observedAt,
      endedAt: last.observedAt,
      frameCount: ready.length,
    };
  }

  private async cleanup(): Promise<void> {
    const before = new Date(Date.now() - this.options.retentionHours * 3_600_000);
    const expired = await this.database.removeExpiredSatelliteAnimationFrames(before);
    await Promise.all(expired.map((filename) => this.store.remove(filename)));
    await this.database.removeExpiredSatelliteCaptureJobs(before);
    await this.store.removeOldAnimations(before);
  }

  private async createStampedFrames(
    animationFilename: string,
    frames: SatelliteAnimationFrameRecord[],
  ): Promise<{ paths: string[]; filenames: string[] }> {
    const filenames = frames.map((_, index) => `.${animationFilename}.${index}.png`);
    await Promise.all(frames.map(async (frame, index) => {
      const filename = filenames[index];
      if (!filename) throw new Error("Satellite animation frame filename is missing");
      const source = await readFile(this.store.path(frame.filename));
      await this.store.write(filename, await stampFrame(source, frame.observedAt, this.options.timeZone));
    }));
    return { filenames, paths: filenames.map((filename) => this.store.path(filename)) };
  }
}

async function stampFrame(data: Uint8Array, observedAt: Date, timeZone: string): Promise<Uint8Array> {
  const image = sharp(data);
  const metadata = await image.metadata();
  const width = metadata.width ?? 1000;
  const height = metadata.height ?? 800;
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(observedAt);
  const label = `EUMETSAT IR · ${time} МСК`;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="12" y="${height - 48}" width="300" height="34" rx="3" fill="#101820" fill-opacity="0.78"/>
    <text x="24" y="${height - 25}" fill="white" font-family="Noto Sans, sans-serif" font-size="18">${label}</text>
  </svg>`;
  return new Uint8Array(await image.composite([{ input: Buffer.from(svg) }]).png().toBuffer());
}

export class SatelliteAnimationStore {
  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  path(filename: string): string {
    if (basename(filename) !== filename) throw new Error(`Unsafe satellite animation filename: ${filename}`);
    return join(this.directory, filename);
  }

  async write(filename: string, data: Uint8Array): Promise<void> {
    const target = this.path(filename);
    const temporary = this.path(`.${filename}.${process.pid}.tmp`);
    await writeFile(temporary, data);
    await rename(temporary, target);
  }

  async existing(frames: SatelliteAnimationFrameRecord[]): Promise<SatelliteAnimationFrameRecord[]> {
    const result: SatelliteAnimationFrameRecord[] = [];
    for (const frame of frames) {
      if (await fileExists(this.path(frame.filename))) result.push(frame);
    }
    return result;
  }

  async remove(filename: string): Promise<void> {
    await rm(this.path(filename), { force: true });
  }

  async removeOldAnimations(before: Date): Promise<void> {
    const files = await readdir(this.directory, { withFileTypes: true });
    await Promise.all(files
      .filter((entry) => entry.isFile() && entry.name.startsWith("animation-") && entry.name.endsWith(".mp4"))
      .map(async (entry) => {
        const path = this.path(entry.name);
        if ((await stat(path)).mtime < before) await rm(path, { force: true });
      }));
  }
}

export class FfmpegAnimationEncoder implements AnimationEncoder {
  async encode(framePaths: string[], outputPath: string): Promise<void> {
    if (framePaths.length === 0) throw new Error("No satellite animation frames to encode");
    const listPath = `${outputPath}.txt`;
    const lines = framePaths.flatMap((path, index) => [
      `file '${path.replaceAll("'", "'\\''")}'`,
      ...(index < framePaths.length - 1 ? [`duration ${FRAME_DURATION_SECONDS}`] : []),
    ]);
    lines.push(`file '${framePaths.at(-1)?.replaceAll("'", "'\\''")}'`);
    await writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
    try {
      await execFileAsync("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outputPath,
      ], { timeout: 120_000, maxBuffer: 1_000_000 });
    } finally {
      await rm(listPath, { force: true });
    }
  }
}

function floorToInterval(date: Date, intervalMinutes: number): Date {
  const intervalMs = intervalMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
}

function fileTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}

function animationCaption(startedAt: Date, endedAt: Date, frameCount: number, timeZone: string): string {
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
  return [
    `Кемь - Кандалакша · движение облачности · ИК-канал`,
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
