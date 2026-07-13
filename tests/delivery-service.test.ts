import { describe, expect, it, vi } from "vitest";
import { DeliveryService } from "../src/application/delivery-service.js";
import type { DeliveryChannel, Publication } from "../src/delivery/types.js";

const publication: Publication = { id: "bulletin-1", text: "weather", attachments: [] };

describe("DeliveryService", () => {
  it("delivers the same neutral publication to every registered channel", async () => {
    const telegram = channel("telegram");
    const max = channel("max");
    const logger = { error: vi.fn() };
    const service = new DeliveryService(
      [telegram, max],
      { getRetryableDeliveryBulletinIds: vi.fn(async () => []) } as never,
      { getStored: vi.fn(async () => null) } as never,
      { intervalSeconds: 30, maxAttempts: 5 },
      logger as never,
    );

    await service.broadcast(publication);

    expect(telegram.broadcast).toHaveBeenCalledWith(publication);
    expect(max.broadcast).toHaveBeenCalledWith(publication);
  });

  it("rebuilds and retries failed recipient deliveries from the database", async () => {
    const telegram = channel("telegram");
    const database = {
      getRetryableDeliveryBulletinIds: vi.fn(async () => ["bulletin-1"]),
    };
    const publications = { getStored: vi.fn(async () => publication) };
    const service = new DeliveryService(
      [telegram],
      database as never,
      publications as never,
      { intervalSeconds: 30, maxAttempts: 5 },
      { error: vi.fn(), warn: vi.fn() } as never,
    );

    await service.start();
    await vi.waitFor(() => expect(telegram.broadcast).toHaveBeenCalledWith(publication));
    await service.stop();

    expect(database.getRetryableDeliveryBulletinIds).toHaveBeenCalledWith("telegram", 5);
    expect(publications.getStored).toHaveBeenCalledWith("bulletin-1");
  });
});

function channel(id: string): DeliveryChannel {
  return {
    id,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    broadcast: vi.fn(async () => undefined),
  };
}
