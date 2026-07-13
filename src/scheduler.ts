import { Cron } from "croner";
import type { DeliveryService } from "./application/delivery-service.js";
import type { PublicationService } from "./application/publication-service.js";
import type { Logger } from "./logger.js";

export class Scheduler {
  private readonly jobs: Cron[];
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    scheduleTimes: string[],
    timeZone: string,
    private readonly retryMinutes: number,
    private readonly recoveryHours: number,
    private readonly publications: PublicationService,
    private readonly delivery: DeliveryService,
    private readonly logger: Logger,
  ) {
    this.jobs = scheduleTimes.map((time) => {
      const [hour, minute] = time.split(":").map(Number);
      return new Cron(`${minute} ${hour} * * *`, {
        timezone: timeZone,
        protect: true,
        paused: true,
      }, async () => {
        const scheduledFor = new Date(Math.floor(Date.now() / 60_000) * 60_000);
        await this.execute(scheduledFor, true);
      });
    });
  }

  async start(): Promise<void> {
    await this.recoverMissedRun();
    for (const job of this.jobs) job.resume();
  }

  stop(): void {
    for (const job of this.jobs) job.stop();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  nextRun(): Date | null {
    return this.jobs
      .map((job) => job.nextRun())
      .filter((date): date is Date => date !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  }

  private async execute(scheduledFor: Date, allowRetry: boolean): Promise<void> {
    try {
      const existing = await this.publications.getScheduled(scheduledFor);
      const publication = existing ?? await this.publications.run({ kind: "scheduled", scheduledFor });
      if (!publication) throw new Error("Collector is busy");
      await this.delivery.broadcast(publication);
    } catch (error) {
      this.logger.error({ error, scheduledFor }, "Scheduled bulletin failed");
      if (!allowRetry) return;
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.execute(scheduledFor, false).catch((retryError: unknown) =>
          this.logger.error({ error: retryError, scheduledFor }, "Deferred retry failed"));
      }, this.retryMinutes * 60_000);
      this.retryTimers.add(timer);
      this.logger.info({ scheduledFor, retryMinutes: this.retryMinutes }, "Deferred retry scheduled");
    }
  }

  private async recoverMissedRun(now = new Date()): Promise<void> {
    const latest = this.jobs
      .flatMap((job) => job.previousRuns(1, now))
      .sort((left, right) => right.getTime() - left.getTime())[0];
    if (!latest) return;

    const ageMs = now.getTime() - latest.getTime();
    if (ageMs > this.recoveryHours * 60 * 60_000) {
      this.logger.info({ scheduledFor: latest, recoveryHours: this.recoveryHours },
        "Scheduled bulletin recovery skipped: last slot is too old");
      return;
    }
    this.logger.info({ scheduledFor: latest }, "Recovering missed scheduled bulletin");
    await this.execute(latest, true);
  }
}
