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
    ].join("\n"), ["Кемский рейд"]);

    expect(formatted).toContain("🌊 <b>Кемь — Кандалакша");
    expect(formatted).toContain("📌 <b>Главное:</b> ветер &lt;сильный&gt;.");
    expect(formatted).toContain("📍 <b>Кемский рейд:</b> ветер 3–7 м/с.");
    expect(formatted).toContain("a=1&amp;b=2");
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
        attachments: [],
      })),
    };
    const channel = new TelegramChannel(
      "123:test",
      {} as never,
      publications as never,
      [],
      { timeZone: "Europe/Moscow" } as never,
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
      "sendMessage",
      "deleteMessage",
    ]);
    expect(calls[0]?.body.text).toContain("Собираю прогноз");
    expect(publications.getFreshOrRun).toHaveBeenCalledOnce();
  });
});
