import { describe, expect, it, vi } from "vitest";
import {
  formatTelegramPost,
  splitMessage,
  TelegramChannel,
} from "../src/delivery/telegram-channel.js";

describe("splitMessage", () => {
  it("splits on line boundaries within Telegram limit", () => {
    const chunks = splitMessage(["one", "two", "three"].join("\n"), 8);
    expect(chunks).toEqual(["one\ntwo", "three"]);
    expect(chunks.every((chunk) => chunk.length <= 8)).toBe(true);
  });
});

describe("formatTelegramPost", () => {
  it("adds readable Telegram HTML while escaping dynamic content", () => {
    const formatted = formatTelegramPost([
      "Кемь — Кандалакша · 11 июля, 14:00 МСК",
      "",
      "Главное: ветер <сильный>.",
      "",
      "Кемский рейд: ветер 3–7 м/с.",
      "Источник: https://example.test/?a=1&b=2",
      "Подробности по моделям:",
      "/details",
    ].join("\n"), ["Кемский рейд"]);

    expect(formatted).toContain("🌊 <b>Кемь — Кандалакша");
    expect(formatted).toContain("📌 <b>Главное:</b> ветер &lt;сильный&gt;.");
    expect(formatted).toContain("📍 <b>Кемский рейд:</b> ветер 3–7 м/с.");
    expect(formatted).toContain("a=1&amp;b=2");
    expect(formatted).toContain("🔬 <b>Подробности по моделям:</b>\n/details");
  });

  it("formats model detail blocks with indentation", () => {
    const formatted = formatTelegramPost([
      "Детализация по моделям · 11 июля, 14:00 МСК",
      "Период: ближайшие 24 часа.",
      "",
      "Кемский рейд",
      "ECMWF: ветер 3–6 м/с.",
      "GFS: ветер 5–9 м/с.",
      "Расхождение: максимальный ветер 3 м/с.",
    ].join("\n"), ["Кемский рейд"]);

    expect(formatted).toContain("📍 <b>Кемский рейд</b>");
    expect(formatted).toContain("  • <b>ECMWF:</b>");
    expect(formatted).toContain("  ↔ <b>Расхождение:</b>");
  });

  it("formats the structured weather bulletin", () => {
    const formatted = formatTelegramPost([
      "Кемь — Кандалакша · гидрометеосводка",
      "Сформировано: 11 июля в 14:00 МСК · прогноз на 24 часа",
      "",
      "Главное",
      "GFS: усиление ветра.",
      "Верхняя граница моделей: ветер до 9 м/с.",
      "",
      "Контрольные точки",
      "Диапазоны: границы ECMWF/GFS, не среднее.",
      "",
      "Кемский рейд",
      "Ветер 3–9 м/с · порывы до 14 м/с.",
      "Осадки 3,8 мм · температура +7…+12 °C.",
    ].join("\n"), ["Кемский рейд"]);

    expect(formatted).toContain("📌 <b>Главное</b>");
    expect(formatted).toContain("📍 <b>Контрольные точки</b>");
    expect(formatTelegramPost("Волна и вода", [])).toContain("🌊 <b>Волна и вода</b>");
    expect(formatted).toContain("  • <b>Ветер</b> 3–9 м/с");
    expect(formatted).toContain("  • <b>Осадки</b> 3,8 мм");
  });
});

describe("TelegramChannel /weather", () => {
  it("sends progress before the publication and removes it afterwards", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const publications = {
      getFreshOrRun: vi.fn(async () => ({
        id: "bulletin-1",
        text: "Кемь — Кандалакша · гидрометеосводка",
        attachments: [{
          kind: "animation" as const,
          data: new Uint8Array([1, 2, 3]),
          contentType: "video/mp4" as const,
          filename: "clouds.mp4",
          caption: "Clouds",
          source: "EUMETSAT",
          startedAt: new Date(),
          endedAt: new Date(),
          frameCount: 3,
        }],
      })),
    };
    const channel = new TelegramChannel(
      "123:test",
      { getMapViewport: vi.fn(async () => null) } as never,
      publications as never,
      [],
      {
        timeZone: "Europe/Moscow",
        satellite: { bbox: [30, 64, 36, 68], width: 1000, height: 800 },
      } as never,
      { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );
    channel.bot.api.config.use(async (_previous, method, payload) => {
      const body = payload as Record<string, unknown>;
      calls.push({ method, body });
      const result = method === "deleteMessage"
        ? true
        : {
          message_id: calls.length,
          date: 1_783_700_000,
          chat: { id: 123, type: "private" },
          text: body.text,
        };
      return { ok: true, result } as never;
    });
    channel.bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    };

    await channel.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_783_700_000,
        chat: { id: 123, type: "private", first_name: "User" },
        from: { id: 123, is_bot: false, first_name: "User" },
        text: "/weather",
        entities: [{ type: "bot_command", offset: 0, length: 8 }],
      },
    });

    expect(calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "sendVideo",
      "sendMessage",
      "deleteMessage",
    ]);
    expect(calls[0]?.body.text).toContain("Собираю прогноз");
    expect(calls[2]?.body.reply_markup).toEqual(expect.objectContaining({
      inline_keyboard: [[
        expect.objectContaining({ callback_data: "bulletin:details" }),
        expect.objectContaining({ callback_data: "bulletin:clouds" }),
      ], [expect.objectContaining({ callback_data: "bulletin:forecast" })]],
    }));
    expect(publications.getFreshOrRun).toHaveBeenCalledOnce();
  });
});

describe("TelegramChannel /forecast", () => {
  it("shows point buttons and replaces the selection with a five-day forecast", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const publications = {
      getPointForecast: vi.fn(async () => [
        "Прогноз на 5 дней · Умба",
        "Обновлено: 11 июля, 12:00 МСК",
        "День: Суббота, 11 июля",
        "ECMWF: ветер 4–8 м/с.",
        "GFS: ветер 5–10 м/с.",
      ].join("\n")),
    };
    const channel = new TelegramChannel(
      "123:test",
      {} as never,
      publications as never,
      [{
        id: "umba", name: "Умба", shortName: "Умба", latitude: 66.679, longitude: 34.31, order: 60, active: true,
      }],
      {
        timeZone: "Europe/Moscow",
        satellite: { bbox: [30, 64, 36, 68], width: 1000, height: 800 },
      } as never,
      { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );
    channel.bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, body: payload as Record<string, unknown> });
      return {
        ok: true,
        result: method === "answerCallbackQuery" ? true : {
          message_id: calls.length,
          date: 1_783_700_000,
          chat: { id: 123, type: "private" },
          text: "ok",
        },
      } as never;
    });
    channel.bot.botInfo = testBotInfo();

    await channel.bot.handleUpdate(commandUpdate("/forecast", 8));
    await channel.bot.handleUpdate({
      update_id: 9,
      callback_query: {
        id: "callback-1",
        from: { id: 123, is_bot: false, first_name: "User" },
        chat_instance: "chat-instance",
        data: "forecast:umba",
        message: {
          message_id: 11,
          date: 1_783_700_000,
          chat: { id: 123, type: "private", first_name: "User" },
          text: "Прогноз на 5 дней",
        },
      },
    });

    expect(calls[0]?.body.reply_markup).toEqual(expect.objectContaining({
      inline_keyboard: [[expect.objectContaining({ callback_data: "forecast:umba" })]],
    }));
    expect(publications.getPointForecast).toHaveBeenCalledWith("umba");
    expect(calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "answerCallbackQuery",
      "editMessageText",
      "editMessageText",
    ]);
    expect(calls.at(-1)?.body.text).toContain("<b>Прогноз на 5 дней · Умба</b>");
  });
});

describe("TelegramChannel /clouds", () => {
  it("sends and removes a progress message around the cloud diagnostic", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const publications = {
      getClouds: vi.fn(async () => [{
        kind: "image" as const,
        data: new Uint8Array([1, 2, 3]),
        contentType: "image/png" as const,
        filename: "clouds.png",
        caption: "Облака",
        source: "EUMETSAT",
        observedAt: new Date(),
      }]),
    };
    const channel = new TelegramChannel(
      "123:test",
      { getMapViewport: vi.fn(async () => null) } as never,
      publications as never,
      [],
      { timeZone: "Europe/Moscow", satellite: { bbox: [30, 64, 36, 68], width: 1000, height: 800 } } as never,
      { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );
    channel.bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, body: payload as Record<string, unknown> });
      return {
        ok: true,
        result: method === "deleteMessage" ? true : {
          message_id: calls.length,
          date: 1_783_700_000,
          chat: { id: 123, type: "private" },
          text: "ok",
        },
      } as never;
    });
    channel.bot.botInfo = testBotInfo();

    await channel.bot.handleUpdate(commandUpdate("/clouds", 10));

    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendPhoto", "deleteMessage"]);
    expect(calls[0]?.body.text).toContain("Собираю информацию об облачности");
    expect(publications.getClouds).toHaveBeenCalledWith(expect.objectContaining({
      bbox: [30, 64, 36, 68],
    }), true);
  });
});

describe("TelegramChannel /help", () => {
  it("shows point, status, and unsubscribe actions as buttons", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const channel = new TelegramChannel(
      "123:test",
      {} as never,
      {} as never,
      [],
      { scheduleTimes: ["05:00"], timeZone: "Europe/Moscow" } as never,
      { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );
    channel.bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, body: payload as Record<string, unknown> });
      return {
        ok: true,
        result: {
          message_id: 1,
          date: 1_783_700_000,
          chat: { id: 123, type: "private" },
          text: "ok",
        },
      } as never;
    });
    channel.bot.botInfo = testBotInfo();

    await channel.bot.handleUpdate(commandUpdate("/help", 11));

    expect(calls[0]?.body.reply_markup).toEqual(expect.objectContaining({
      inline_keyboard: [
        [
          expect.objectContaining({ callback_data: "help:points" }),
          expect.objectContaining({ callback_data: "help:status" }),
        ],
        [expect.objectContaining({ callback_data: "help:stop" })],
      ],
    }));
  });
});

describe("TelegramChannel /start", () => {
  it("shows weather and five-day forecast actions without an unsubscribe button", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const database = { subscribe: vi.fn(async () => undefined) };
    const channel = new TelegramChannel(
      "123:test",
      database as never,
      {} as never,
      [],
      { scheduleTimes: ["05:00"], timeZone: "Europe/Moscow" } as never,
      { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );
    channel.bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, body: payload as Record<string, unknown> });
      return {
        ok: true,
        result: {
          message_id: 1,
          date: 1_783_700_000,
          chat: { id: 123, type: "private" },
          text: "ok",
        },
      } as never;
    });
    channel.bot.botInfo = testBotInfo();

    await channel.bot.handleUpdate(commandUpdate("/start", 12));

    expect(database.subscribe).toHaveBeenCalledWith("telegram", "123");
    const keyboard = calls[0]?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(keyboard.inline_keyboard.flat().map((button) => button.callback_data)).toEqual([
      "help:weather",
      "help:forecast",
      "help:points",
      "help:status",
    ]);
  });
});

describe("TelegramChannel /map", () => {
  it("sends the current satellite image with map controls", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const publications = {
      getMap: vi.fn(async () => ({
        kind: "image" as const,
        data: new Uint8Array([1, 2, 3]),
        contentType: "image/png" as const,
        filename: "map.png",
        caption: "Спутниковый снимок",
        source: "EUMETSAT",
        observedAt: new Date(),
      })),
    };
    const channel = new TelegramChannel(
      "123:test",
      { getMapViewport: vi.fn(async () => null) } as never,
      publications as never,
      [],
      {
        timeZone: "Europe/Moscow",
        satellite: { bbox: [30, 64, 36, 68], width: 1000, height: 800 },
      } as never,
      { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    );
    channel.bot.api.config.use(async (_previous, method, payload) => {
      const body = payload as Record<string, unknown>;
      calls.push({ method, body });
      return {
        ok: true,
        result: {
          message_id: calls.length,
          date: 1_783_700_000,
          chat: { id: 123, type: "private" },
          photo: [],
        },
      } as never;
    });
    channel.bot.botInfo = testBotInfo();

    await channel.bot.handleUpdate(commandUpdate("/map", 4));

    expect(calls.map((call) => call.method)).toEqual(["sendChatAction", "sendPhoto"]);
    expect(publications.getMap).toHaveBeenCalledWith(expect.objectContaining({
      bbox: [30, 64, 36, 68],
      width: 1000,
      height: 800,
    }));
    expect(calls[1]?.body.caption).toContain("Охват: примерно");
  });
});

describe("TelegramChannel personal animation", () => {
  it("queues a custom animation after /weather without attaching the standard one", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const publications = {
      getFreshOrRun: vi.fn(async () => ({ id: "bulletin-1", text: "Weather", attachments: [] })),
    };
    const personalAnimations = { request: vi.fn(async () => "queued") };
    const channel = new TelegramChannel(
      "123:test",
      { getMapViewport: vi.fn(async () => [30.5, 64, 36.5, 68]) } as never,
      publications as never,
      [],
      {
        timeZone: "Europe/Moscow",
        satellite: { bbox: [30, 64, 36, 68], width: 1000, height: 800 },
      } as never,
      { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      personalAnimations as never,
    );
    channel.bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, body: payload as Record<string, unknown> });
      return {
        ok: true,
        result: method === "deleteMessage" ? true : {
          message_id: calls.length,
          date: 1_783_700_000,
          chat: { id: 123, type: "private" },
          text: "ok",
        },
      } as never;
    });
    channel.bot.botInfo = testBotInfo();

    await channel.bot.handleUpdate(commandUpdate("/weather", 5));
    await vi.waitFor(() => expect(personalAnimations.request).toHaveBeenCalledOnce());

    expect(publications.getFreshOrRun).toHaveBeenCalledWith(expect.objectContaining({
      bbox: [30.5, 64, 36.5, 68],
    }), false);
    expect(personalAnimations.request).toHaveBeenCalledWith(
      "telegram",
      "123",
      "satellite",
      expect.objectContaining({ bbox: [30.5, 64, 36.5, 68] }),
    );
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage", "deleteMessage"]);
  });
});

function commandUpdate(text: string, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1_783_700_000,
      chat: { id: 123, type: "private" as const, first_name: "User" },
      from: { id: 123, is_bot: false as const, first_name: "User" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: text.length }],
    },
  };
}

function testBotInfo() {
  return {
    id: 999,
    is_bot: true as const,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}
