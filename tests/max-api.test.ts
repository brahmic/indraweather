import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_API_BASE_URL, MaxApiClient } from "../src/infrastructure/max-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("MaxApiClient", () => {
  it("uses the fixed API v2 endpoint and registers the production webhook", async () => {
    const calls: Array<{ url: URL; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      calls.push({ url, method, body });
      let response: unknown;
      if (url.pathname === "/me") {
        response = { user_id: 7, name: "Weather", username: "weather_bot", is_bot: true };
      } else {
        response = { success: true };
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const client = new MaxApiClient("secret", 1000);

    const username = await client.initialize(
      "https://weather.example.ru/webhooks/max",
      "webhook-secret",
    );

    expect(username).toBe("weather_bot");
    expect(calls.every((call) => call.url.origin === MAX_API_BASE_URL)).toBe(true);
    const subscription = calls.find((call) =>
      call.url.pathname === "/subscriptions" && call.method === "POST");
    expect(subscription?.body).toEqual({
      url: "https://weather.example.ru/webhooks/max",
      update_types: ["message_created", "bot_started", "bot_stopped"],
      secret: "webhook-secret",
    });
  });
});
