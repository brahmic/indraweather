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

  start(): void {
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
      const publication = await this.publications.run({ kind: "scheduled", scheduledFor });
      if (publication) await this.delivery.broadcast(publication);
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
}
