import { describe, expect, it } from "vitest";
import { formatHelpHtml } from "../src/delivery/help-text.js";

describe("formatHelpHtml", () => {
  it("lists commands and the interpretation rules shared by both channels", () => {
    const text = formatHelpHtml(["05:00", "11:00", "17:00", "23:00"]);

    expect(text).toContain("05:00, 11:00, 17:00, 23:00 МСК");
    expect(text).toContain("<code>/weather</code>");
    expect(text).toContain("<code>/forecast</code>");
    expect(text).toContain("кнопки «Детали», «Облачность», «Прогноз погоды» и «Движение облаков»");
    expect(text).toContain("границы моделей, а не среднее значение");
    expect(text).toContain("При расхождении под точкой приводятся оба сценария моделей");
    expect(text).toContain("Время динамики и поворота — интервал прогноза");
    expect(text).toContain("Прилив в строке точки показывает направление воды и начало отлива");
    expect(text).toContain("<code>/map</code>");
    expect(text).toContain("На обзорных снимках отмечены все активные контрольные точки");
    expect(text).toContain("Модельная карта в бюллетене и <code>/forecast</code> строится по свежему выпуску");
    expect(text).toContain("сама ничего не отправляет");
    expect(text).toContain("после <code>/start</code>");
    expect(text).not.toContain("<code>/points</code>");
    expect(text).not.toContain("<code>/status</code>");
    expect(text).not.toContain("<code>/stop</code>");
  });

  it("marks the subscription as enabled only in the welcome variant", () => {
    expect(formatHelpHtml(["05:00"], true)).toContain("Подписка включена");
  });
});
