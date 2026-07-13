import type { DeliveryChannel, Publication } from "../delivery/types.js";
import type { PublicationService } from "./publication-service.js";
import type { Database } from "../infrastructure/database.js";
import type { Logger } from "../logger.js";

export interface DeliveryRetryOptions {
  intervalSeconds: number;
  maxAttempts: number;
}

export class DeliveryService {
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retryWorker: Promise<void> | null = null;

  constructor(
    private readonly channels: DeliveryChannel[],
    private readonly database: Database,
    private readonly publications: PublicationService,
    private readonly retryOptions: DeliveryRetryOptions,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.start()));
    this.retryTimer = setInterval(() => this.retryFailedDeliveries(),
      this.retryOptions.intervalSeconds * 1000);
    this.retryFailedDeliveries();
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    await this.retryWorker;
    await Promise.allSettled(this.channels.map((channel) => channel.stop()));
  }

  async broadcast(publication: Publication): Promise<void> {
    const results = await Promise.allSettled(
      this.channels.map((channel) => channel.broadcast(publication)),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        this.logger.error({
          channel: this.channels[index]?.id,
          error: result.reason,
          publicationId: publication.id,
        }, "Delivery channel failed");
      }
    }
  }

  private retryFailedDeliveries(): void {
    if (this.retryWorker) return;
    this.retryWorker = this.processRetries()
      .catch((error: unknown) => this.logger.error({ error }, "Delivery retry worker failed"))
      .finally(() => {
        this.retryWorker = null;
      });
  }

  private async processRetries(): Promise<void> {
    for (const channel of this.channels) {
      const bulletinIds = await this.database.getRetryableDeliveryBulletinIds(
        channel.id,
        this.retryOptions.maxAttempts,
      );
      for (const bulletinId of bulletinIds) {
        const publication = await this.publications.getStored(bulletinId);
        if (!publication) {
          this.logger.warn({ bulletinId, channel: channel.id }, "Retryable delivery bulletin is missing");
          continue;
        }
        await channel.broadcast(publication);
      }
    }
  }
}
