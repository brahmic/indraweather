import { describe, expect, it } from "vitest";
import { formatHelpHtml } from "../src/delivery/help-text.js";

describe("formatHelpHtml", () => {
  it("lists commands and the interpretation rules shared by both channels", () => {
    const text = formatHelpHtml(["05:00", "11:00", "17:00", "23:00"]);

    expect(text).toContain("05:00, 11:00, 17:00, 23:00 МСК");
    expect(text).toContain("<code>/weather</code>");
    expect(text).toContain("границы моделей, а не среднее значение");
    expect(text).toContain("<code>/map</code>");
    expect(text).toContain("сама ничего не отправляет");
    expect(text).toContain("после <code>/start</code>");
  });

  it("marks the subscription as enabled only in the welcome variant", () => {
    expect(formatHelpHtml(["05:00"], true)).toContain("Подписка включена");
  });
});
