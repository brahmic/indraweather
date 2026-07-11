import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer } from "../src/health.js";

const servers: Array<ReturnType<typeof startHealthServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("HTTP server", () => {
  it("routes authenticated MAX webhook requests", async () => {
    const receiver = {
      webhookPath: "/webhooks/max",
      acceptWebhook: vi.fn(async () => "accepted" as const),
    };
    const server = startHealthServer(
      { ping: vi.fn(async () => undefined) } as never,
      0,
      { info: vi.fn(), error: vi.fn() } as never,
      receiver,
    );
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server has no TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/max`, {
      method: "POST",
      headers: { "x-max-bot-api-secret": "secret" },
      body: '{"update_type":"bot_started"}',
    });

    expect(response.status).toBe(200);
    expect(receiver.acceptWebhook).toHaveBeenCalledWith(
      "secret",
      '{"update_type":"bot_started"}',
    );
  });
});
