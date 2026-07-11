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
      logger as never,
    );

    await service.broadcast(publication);

    expect(telegram.broadcast).toHaveBeenCalledWith(publication);
    expect(max.broadcast).toHaveBeenCalledWith(publication);
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
