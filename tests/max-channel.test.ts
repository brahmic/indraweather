import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MaxChannel } from "../src/delivery/max-channel.js";
import type { Publication } from "../src/delivery/types.js";

describe("MaxChannel", () => {
  it("authenticates and enqueues webhook updates", async () => {
    const database = databaseStub();
    const api = apiStub();
    const channel = createChannel(database, api);
    await channel.start();
    const body = JSON.stringify({
      update_type: "bot_started",
      timestamp: 1,
      chat_id: 42,
      user: { user_id: 42, is_bot: false },
    });

    expect(await channel.acceptWebhook("wrong", body)).toBe("unauthorized");
    expect(await channel.acceptWebhook(webhookSecret("token"), body)).toBe("accepted");
    expect(database.enqueueMaxWebhook).toHaveBeenCalledWith(
      createHash("sha256").update(body).digest("hex"),
      expect.objectContaining({ update_type: "bot_started" }),
    );
    await channel.stop();
  });

  it("processes /details from the durable queue", async () => {
    const database = databaseStub();
    database.claimMaxWebhook
      .mockResolvedValueOnce({
        fingerprint: "event-1",
        attempts: 1,
        payload: {
          update_type: "message_created",
          timestamp: 1,
          message: {
            sender: { user_id: 42, is_bot: false },
            recipient: { chat_id: 42, chat_type: "dialog" },
            body: { mid: "message-1", text: "/details" },
          },
        },
      } as never)
      .mockResolvedValueOnce(null);
    const api = apiStub();
    const channel = createChannel(database, api);

    await channel.start();
    await vi.waitFor(() => expect(database.completeMaxWebhook).toHaveBeenCalledWith("event-1"));

    expect(api.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining("<b>details</b>"),
    );
    await channel.stop();
  });

  it("uploads each image once for a multi-recipient broadcast", async () => {
    const database = databaseStub();
    database.getActiveRecipientIds.mockResolvedValue(["41", "42"]);
    database.claimDelivery.mockResolvedValue(true);
    const api = apiStub();
    const channel = createChannel(database, api);
    const publication: Publication = {
      id: "bulletin-1",
      text: "weather",
      attachments: [{
        kind: "image",
        data: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        filename: "satellite.png",
        caption: "Satellite",
        source: "EUMETSAT",
        observedAt: new Date(),
      }],
    };

    await channel.broadcast(publication);

    expect(api.uploadImage).toHaveBeenCalledWith(expect.any(Uint8Array), "satellite.png");
    expect(database.markDelivery).toHaveBeenCalledTimes(2);
  });

  it("uploads one shared animation for every broadcast recipient", async () => {
    const database = databaseStub();
    database.getActiveRecipientIds.mockResolvedValue(["41", "42"]);
    database.claimDelivery.mockResolvedValue(true);
    const api = apiStub();
    const channel = createChannel(database, api);
    const publication: Publication = {
      id: "bulletin-1",
      text: "weather",
      attachments: [{
        kind: "animation",
        data: new Uint8Array([1, 2, 3]),
        contentType: "video/mp4",
        filename: "clouds.mp4",
        caption: "Clouds",
        source: "EUMETSAT",
        startedAt: new Date(),
        endedAt: new Date(),
        frameCount: 3,
      }],
    };

    await channel.broadcast(publication);

    expect(api.uploadVideo).toHaveBeenCalledWith(expect.any(Uint8Array), "clouds.mp4");
    expect(database.markDelivery).toHaveBeenCalledTimes(2);
  });

  it("still sends the weather text when MAX rejects an attachment", async () => {
    const database = databaseStub();
    database.claimMaxWebhook
      .mockResolvedValueOnce({
        fingerprint: "event-weather",
        attempts: 1,
        payload: weatherUpdate(),
      } as never)
      .mockResolvedValueOnce(null);
    const api = apiStub();
    api.uploadImage.mockRejectedValueOnce(new Error("upload unavailable"));
    const publication: Publication = {
      id: "bulletin-1",
      text: "weather",
      attachments: [{
        kind: "image",
        data: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        filename: "satellite.png",
        caption: "Satellite",
        source: "EUMETSAT",
        observedAt: new Date(),
      }],
    };
    const channel = new MaxChannel(
      "token",
      "https://weather.example.ru",
      database as never,
      { getFreshOrRun: vi.fn(async () => publication) } as never,
      [],
      appConfig() as never,
      api,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );

    await channel.start();
    await vi.waitFor(() => expect(database.completeMaxWebhook).toHaveBeenCalledWith("event-weather"));

    expect(api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("weather"));
    expect(api.editMessage).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("sends /map with an inline keyboard", async () => {
    const database = databaseStub();
    database.claimMaxWebhook
      .mockResolvedValueOnce({
        fingerprint: "event-map",
        attempts: 1,
        payload: messageUpdate("/map"),
      } as never)
      .mockResolvedValueOnce(null);
    const api = apiStub();
    const publications = {
      getMap: vi.fn(async () => mapImage()),
    };
    const channel = new MaxChannel(
      "token",
      "https://weather.example.ru",
      database as never,
      publications as never,
      [],
      appConfig() as never,
      api,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );

    await channel.start();
    await vi.waitFor(() => expect(database.completeMaxWebhook).toHaveBeenCalledWith("event-map"));

    expect(publications.getMap).toHaveBeenCalledWith(expect.objectContaining({
      bbox: [30, 64, 36, 68],
    }));
    expect(api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("Охват: примерно"), [
      expect.objectContaining({ type: "image" }),
      expect.objectContaining({ type: "inline_keyboard" }),
    ]);
    await channel.stop();
  });

  it("updates the same MAX map message through a callback", async () => {
    const database = databaseStub();
    database.claimMaxWebhook
      .mockResolvedValueOnce({
        fingerprint: "event-map-callback",
        attempts: 1,
        payload: {
          update_type: "message_callback",
          timestamp: 1,
          callback: {
            timestamp: 1,
            callback_id: "callback-1",
            payload: "map:right",
            user: { user_id: 42, is_bot: false },
          },
        },
      } as never)
      .mockResolvedValueOnce(null);
    const api = apiStub();
    const publications = {
      getMap: vi.fn(async () => mapImage()),
    };
    const channel = new MaxChannel(
      "token",
      "https://weather.example.ru",
      database as never,
      publications as never,
      [],
      appConfig() as never,
      api,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );

    await channel.start();
    await vi.waitFor(() => expect(database.completeMaxWebhook).toHaveBeenCalledWith("event-map-callback"));

    expect(database.saveMapViewport).toHaveBeenCalledWith(
      "max",
      "42",
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(api.answerCallback).toHaveBeenCalledWith("callback-1", {
      text: expect.stringContaining("Охват: примерно"),
      attachments: [
        expect.objectContaining({ type: "image" }),
        expect.objectContaining({ type: "inline_keyboard" }),
      ],
    });
    await channel.stop();
  });

  it("queues a custom animation after MAX /weather", async () => {
    const database = databaseStub();
    database.getMapViewport.mockResolvedValue([30.5, 64, 36.5, 68]);
    database.claimMaxWebhook
      .mockResolvedValueOnce({
        fingerprint: "event-weather-custom",
        attempts: 1,
        payload: weatherUpdate(),
      } as never)
      .mockResolvedValueOnce(null);
    const api = apiStub();
    const publications = {
      getFreshOrRun: vi.fn(async () => ({ id: "bulletin-1", text: "Weather", attachments: [] })),
    };
    const personalAnimations = { request: vi.fn(async () => "queued") };
    const channel = new MaxChannel(
      "token",
      "https://weather.example.ru",
      database as never,
      publications as never,
      [],
      appConfig() as never,
      api,
      { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      personalAnimations as never,
    );

    await channel.start();
    await vi.waitFor(() => expect(personalAnimations.request).toHaveBeenCalledOnce());

    expect(publications.getFreshOrRun).toHaveBeenCalledWith(expect.objectContaining({
      bbox: [30.5, 64, 36.5, 68],
    }), false);
    expect(personalAnimations.request).toHaveBeenCalledWith(
      "max",
      "42",
      "satellite",
      expect.objectContaining({ bbox: [30.5, 64, 36.5, 68] }),
    );
    await channel.stop();
  });
});

function createChannel(database: ReturnType<typeof databaseStub>, api: ReturnType<typeof apiStub>) {
  return new MaxChannel(
    "token",
    "https://weather.example.ru",
    database as never,
    {
      getFreshDetails: vi.fn(async () => "details"),
      getFreshOrRun: vi.fn(),
    } as never,
    [],
    appConfig() as never,
    api,
    { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
  );
}

function databaseStub() {
  return {
    resetProcessingMaxWebhooks: vi.fn(async () => undefined),
    enqueueMaxWebhook: vi.fn(async () => true),
    claimMaxWebhook: vi.fn(async () => null),
    completeMaxWebhook: vi.fn(async () => undefined),
    failMaxWebhook: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    getActiveRecipientIds: vi.fn(async () => [] as string[]),
    claimDelivery: vi.fn(async () => false),
    markDelivery: vi.fn(async () => undefined),
    getLastSuccessfulUpdate: vi.fn(async () => null),
    getMapViewport: vi.fn(async () => null as [number, number, number, number] | null),
    saveMapViewport: vi.fn(async () => undefined),
  };
}

function apiStub() {
  let message = 0;
  return {
    initialize: vi.fn(async () => "weather_bot"),
    uploadImage: vi.fn(async () => ({ type: "image" as const, payload: { token: "image" } })),
    uploadVideo: vi.fn(async () => ({ type: "video" as const, payload: { token: "video" } })),
    sendMessage: vi.fn(async () => `message-${message += 1}`),
    editMessage: vi.fn(async () => undefined),
    answerCallback: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
}

function appConfig() {
  return {
    timeZone: "Europe/Moscow",
    satellite: { bbox: [30, 64, 36, 68], width: 1000, height: 800 },
  };
}

function webhookSecret(token: string): string {
  return createHash("sha256").update("indra:max-webhook:v1\0").update(token).digest("hex");
}

function weatherUpdate() {
  return messageUpdate("/weather");
}

function messageUpdate(text: string) {
  return {
    update_type: "message_created",
    timestamp: 1,
    message: {
      sender: { user_id: 42, is_bot: false },
      recipient: { chat_id: 42, chat_type: "dialog" },
      body: { mid: "message-1", text },
    },
  };
}

function mapImage() {
  return {
    kind: "image" as const,
    data: new Uint8Array([1, 2, 3]),
    contentType: "image/png" as const,
    filename: "map.png",
    caption: "Спутниковый снимок",
    source: "EUMETSAT",
    observedAt: new Date(),
  };
}
