import { readFile, rename, rm, stat } from "node:fs/promises";
import type { AnimationAttachment, ImageAttachment } from "../delivery/types.js";
import { createMapViewport, type MapViewport } from "../domain/map-viewport.js";
import type {
  Database,
  PersonalAnimationJobRecord,
  PersonalAnimationKind,
} from "../infrastructure/database.js";
import type { Logger } from "../logger.js";
import {
  AnimationStore,
  FfmpegAnimationEncoder,
  stampAnimationFrame,
} from "./satellite-animation-service.js";

export interface PersonalAnimationFrame {
  observedAt: Date;
  source: string;
  label: string;
}

export interface PersonalAnimationSource {
  readonly kind: PersonalAnimationKind;
  getContext(): string;
  getFrames(since: Date, context: string): Promise<PersonalAnimationFrame[]>;
  createFrameFetcher(
    viewport: MapViewport,
    context: string,
  ): Promise<(frame: PersonalAnimationFrame) => Promise<ImageAttachment>>;
}

export interface PersonalAnimationOptions {
  windowHours: number;
  retentionHours: number;
  minFrames: number;
  maxBytes: number;
  cacheMinutes: number;
  timeZone: string;
}

interface AnimationEncoder {
  encode(framePaths: string[], outputPath: string): Promise<void>;
}

interface MapContextOverlay {
  withViewport(viewport: MapViewport): MapContextOverlay;
  applyContext(image: Uint8Array): Promise<Uint8Array>;
}

interface WindOverlay {
  withViewport(viewport: MapViewport): WindOverlay;
  apply(image: Uint8Array, referenceAt: Date, placement?: { headerTop?: number }): Promise<Uint8Array>;
}

type Delivery = (job: PersonalAnimationJobRecord, attachment: AnimationAttachment) => Promise<void>;

export class PersonalAnimationService {
  private readonly sources = new Map<PersonalAnimationKind, PersonalAnimationSource>();
  private worker: Promise<void> | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private delivery: Delivery | null = null;

  constructor(
    private readonly database: Database,
    sources: PersonalAnimationSource[],
    private readonly mapContext: MapContextOverlay,
    private readonly windOverlay: WindOverlay,
    private readonly store: AnimationStore,
    private readonly options: PersonalAnimationOptions,
    private readonly logger: Logger,
    private readonly encoder: AnimationEncoder = new FfmpegAnimationEncoder(),
  ) {
    for (const source of sources) this.sources.set(source.kind, source);
  }

  setDelivery(delivery: Delivery): void {
    this.delivery = delivery;
  }

  async start(): Promise<void> {
    await this.store.initialize();
    await this.database.resetProcessingPersonalAnimations();
    this.queueTimer = setInterval(() => this.kick(), 15_000);
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    await this.worker;
  }

  async request(
    channel: string,
    recipientId: string,
    kind: PersonalAnimationKind,
    viewport: MapViewport,
  ): Promise<"queued" | "cached" | "unavailable"> {
    const source = this.sources.get(kind);
    if (!source) return "unavailable";
    const viewportKey = mapKey(viewport);
    const context = source.getContext();
    const cached = await this.database.getCachedPersonalAnimation(
      channel,
      recipientId,
      kind,
      viewportKey,
      context,
      new Date(Date.now() - this.options.cacheMinutes * 60_000),
    );
    if (cached) {
      void this.deliverCached(cached);
      return "cached";
    }
    const frames = await source.getFrames(this.windowStart(), context);
    if (frames.length < this.options.minFrames) return "unavailable";
    await this.database.enqueuePersonalAnimation(
      channel,
      recipientId,
      kind,
      viewportKey,
      context,
      viewport.bbox,
      viewport.width,
      viewport.height,
    );
    this.kick();
    return "queued";
  }

  private kick(): void {
    if (this.worker) return;
    this.worker = this.processQueue()
      .catch((error: unknown) => this.logger.error({ error }, "Personal animation worker failed"))
      .finally(() => {
        this.worker = null;
      });
  }

  private async processQueue(): Promise<void> {
    let job: PersonalAnimationJobRecord | null;
    while ((job = await this.database.claimPersonalAnimation())) {
      const currentJob = job;
      try {
        if (!await this.isCurrent(currentJob)) {
          await this.database.cancelPersonalAnimation(currentJob.id);
          continue;
        }
        const attachment = await this.render(currentJob);
        if (!await this.isCurrent(currentJob)) {
          await this.store.remove(attachment.filename);
          await this.database.cancelPersonalAnimation(currentJob.id);
          continue;
        }
        if (!this.delivery) throw new Error("Personal animation delivery is not configured");
        await this.delivery(currentJob, attachment);
        await this.database.completePersonalAnimation(
          currentJob.id,
          attachment.filename,
          attachment.source,
          attachment.startedAt,
          attachment.endedAt,
          attachment.frameCount,
        );
        await this.cleanup().catch((error: unknown) =>
          this.logger.warn({ error, jobId: currentJob.id }, "Personal animation cleanup failed"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.database.failPersonalAnimation(currentJob.id, message, currentJob.attempts);
        this.logger.warn(
          { error, jobId: currentJob.id, kind: currentJob.kind },
          "Personal animation rendering failed",
        );
      }
    }
  }

  private async render(job: PersonalAnimationJobRecord): Promise<AnimationAttachment> {
    const source = this.sources.get(job.kind);
    if (!source) throw new Error(`Personal animation source is disabled: ${job.kind}`);
    const frames = await source.getFrames(this.windowStart(), job.context);
    const viewport = createMapViewport(job.bbox, job.width, job.height);
    const mapContext = this.mapContext.withViewport(viewport);
    const windOverlay = this.windOverlay.withViewport(viewport);
    const getFrame = await source.createFrameFetcher(viewport, job.context);
    const fetched = await mapConcurrent(frames, 3, async (frame) => {
      try {
        const image = await getFrame(frame);
        return { frame, image };
      } catch (error) {
        this.logger.warn(
          { error, jobId: job.id, observedAt: frame.observedAt },
          "Personal animation frame is unavailable",
        );
        return null;
      }
    });
    const available = fetched.filter((item): item is { frame: PersonalAnimationFrame; image: ImageAttachment } => item !== null);
    if (available.length < this.options.minFrames) {
      throw new Error(`Personal animation has ${available.length} usable frames; ${this.options.minFrames} required`);
    }
    const ready = await mapConcurrent(available, 3, async ({ frame, image }, index) => {
      const stamped = await stampAnimationFrame(
        image.data,
        frame.observedAt,
        this.options.timeZone,
        frame.label,
        index === available.length - 1,
      );
      const mapped = await mapContext.applyContext(stamped);
      const data = index === available.length - 1
        ? await windOverlay.apply(mapped, frame.observedAt, { headerTop: 56 })
        : mapped;
      const filename = `.personal-${job.id}-${index}.png`;
      await this.store.write(filename, data);
      return { frame, filename };
    });
    const first = ready[0];
    const last = ready.at(-1);
    if (!first || !last) throw new Error("Personal animation frame list is empty");
    const filename = `personal-${job.kind}-${job.id}-${fileTime(first.frame.observedAt)}-${fileTime(last.frame.observedAt)}.mp4`;
    const temporaryPath = this.store.path(`.${filename}.tmp.mp4`);
    try {
      await this.encoder.encode(ready.map((item) => this.store.path(item.filename)), temporaryPath);
      const output = await stat(temporaryPath);
      if (output.size > this.options.maxBytes) {
        throw new Error(`Personal animation exceeds ${this.options.maxBytes} bytes`);
      }
      await rename(temporaryPath, this.store.path(filename));
    } finally {
      await rm(temporaryPath, { force: true });
      await Promise.all(ready.map((item) => this.store.remove(item.filename)));
    }
    return {
      kind: "animation",
      data: await readFile(this.store.path(filename)),
      contentType: "video/mp4",
      filename,
      caption: animationCaption(
        job.kind,
        job.context,
        first.frame.observedAt,
        last.frame.observedAt,
        ready.length,
        this.options.timeZone,
      ),
      source: first.frame.source,
      startedAt: first.frame.observedAt,
      endedAt: last.frame.observedAt,
      frameCount: ready.length,
    };
  }

  private async deliverCached(job: PersonalAnimationJobRecord): Promise<void> {
    try {
      if (!await this.isCurrent(job) || !this.delivery) return;
      if (!job.outputFilename || !job.source || !job.startedAt || !job.endedAt || !job.frameCount) return;
      const attachment: AnimationAttachment = {
        kind: "animation",
        data: await readFile(this.store.path(job.outputFilename)),
        contentType: "video/mp4",
        filename: job.outputFilename,
        caption: animationCaption(
          job.kind,
          job.context,
          job.startedAt,
          job.endedAt,
          job.frameCount,
          this.options.timeZone,
        ),
        source: job.source,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        frameCount: job.frameCount,
      };
      await this.delivery(job, attachment);
    } catch (error) {
      this.logger.warn({ error, jobId: job.id }, "Cached personal animation delivery failed");
    }
  }

  private async isCurrent(job: PersonalAnimationJobRecord): Promise<boolean> {
    return this.database.isMapViewportCurrent(job.channel, job.recipientId, job.bbox);
  }

  private async cleanup(): Promise<void> {
    const before = new Date(Date.now() - this.options.retentionHours * 3_600_000);
    const filenames = await this.database.removeExpiredPersonalAnimations(before);
    await Promise.all(filenames.map((filename) => this.store.remove(filename)));
    await this.store.removeOldAnimations(before);
  }

  private windowStart(): Date {
    return new Date(Date.now() - this.options.windowHours * 3_600_000);
  }
}

function mapKey(viewport: MapViewport): string {
  return `${viewport.bbox.map((value) => value.toFixed(6)).join(",")}:${viewport.width}x${viewport.height}`;
}

function fileTime(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
}

function animationCaption(
  kind: PersonalAnimationKind,
  context: string,
  startedAt: Date,
  endedAt: Date,
  frameCount: number,
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
  const title = kind === "satellite"
    ? "пользовательский охват · движение облачности · ИК-канал"
    : context === "fog"
    ? "пользовательский охват · туман и низкая облачность · движение"
    : "пользовательский охват · типы облаков · движение";
  return [
    `Кемь - Кандалакша · ${title}`,
    `${formatter.format(startedAt)} - ${formatter.format(endedAt)} МСК · ${duration} · ${frameCount} кадров`,
    "Источник: EUMETSAT EUMETView",
  ].join("\n");
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await operation(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
