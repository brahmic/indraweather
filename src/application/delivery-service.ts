import type { DeliveryChannel, Publication } from "../delivery/types.js";
import type { Logger } from "../logger.js";

export class DeliveryService {
  constructor(
    private readonly channels: DeliveryChannel[],
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.start()));
  }

  async stop(): Promise<void> {
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
}
