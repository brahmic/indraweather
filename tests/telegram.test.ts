import { describe, expect, it } from "vitest";
import { formatTelegramPost, splitMessage } from "../src/delivery/telegram-channel.js";

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
