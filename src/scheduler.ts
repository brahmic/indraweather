import { Cron } from "croner";
import type { DeliveryService } from "./application/delivery-service.js";
import type { PublicationService } from "./application/publication-service.js";
import type { Logger } from "./logger.js";

export class Scheduler {
  private readonly jobs: Cron[];
  private readonly preparationJobs: Cron[];
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    scheduleTimes: string[],
    timeZone: string,
    private readonly prepareMinutes: number,
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
    this.preparationJobs = scheduleTimes.map((time) => {
      const [hour, minute] = subtractMinutes(time, prepareMinutes);
      return new Cron(`${minute} ${hour} * * *`, {
        timezone: timeZone,
        protect: true,
        paused: true,
      }, async () => {
        const scheduledFor = new Date(
          Math.floor(Date.now() / 60_000) * 60_000 + prepareMinutes * 60_000,
        );
        await this.prepare(scheduledFor);
      });
    });
  }

  async start(): Promise<void> {
    await this.recoverMissedRun();
    for (const job of this.preparationJobs) job.resume();
    for (const job of this.jobs) job.resume();
  }

  stop(): void {
    for (const job of this.jobs) job.stop();
    for (const job of this.preparationJobs) job.stop();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  nextRun(after?: Date): Date | null {
    return this.jobs
      .map((job) => job.nextRun(after))
      .filter((date): date is Date => date !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  }

  private async execute(scheduledFor: Date, allowRetry: boolean): Promise<void> {
    try {
      let publication = await this.publications.getScheduled(scheduledFor);
      if (!publication) {
        try {
          publication = await this.publications.run({ kind: "scheduled", scheduledFor });
        } catch (error) {
          this.logger.error({ error, scheduledFor }, "Scheduled bulletin collection failed");
        }
      }
      publication ??= await this.publications.createScheduledFallback(scheduledFor);
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

  private async prepare(scheduledFor: Date): Promise<void> {
    try {
      if (await this.publications.getScheduled(scheduledFor)) return;
      const publication = await this.publications.run({ kind: "scheduled", scheduledFor });
      if (!publication) {
        this.logger.warn(
          { scheduledFor, prepareMinutes: this.prepareMinutes },
          "Scheduled bulletin preparation skipped because collector is busy",
        );
        return;
      }
      this.logger.info(
        { scheduledFor, prepareMinutes: this.prepareMinutes, bulletinId: publication.id },
        "Scheduled bulletin prepared",
      );
    } catch (error) {
      this.logger.error({ error, scheduledFor }, "Scheduled bulletin preparation failed");
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

function subtractMinutes(time: string, amount: number): [hour: number, minute: number] {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const minutesPerDay = 24 * 60;
  const result = (hour * 60 + minute - amount + minutesPerDay) % minutesPerDay;
  return [Math.floor(result / 60), result % 60];
}
