import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { OfficialWarning } from "../domain/types.js";
import { fetchText } from "./http.js";

const SOURCE = "ФГБУ «Мурманское УГМС»";
const SOURCE_URL = "https://www.kolgimet.ru/";
const NO_WARNING = /(?:опасных явлений[^.]*не ожидается|шторма нет)/iu;

export class KolgimetClient {
  constructor(
    private readonly timeoutMs: number,
    private readonly retries: number,
  ) {}

  async getWarnings(): Promise<OfficialWarning[]> {
    const html = await fetchText(SOURCE_URL, {
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    });
    const $ = cheerio.load(html);
    const heading = $("h2").filter((_, element) =>
      $(element).text().toLocaleLowerCase("ru-RU").includes("штормовое предупреждение")
    ).first();
    if (heading.length === 0) {
      throw new Error("Kolgimet warning heading was not found");
    }

    const parts: string[] = [];
    let current = heading.next();
    while (current.length > 0 && !current.is("h1, h2")) {
      const text = normalizeWhitespace(current.text());
      if (text) parts.push(text);
      current = current.next();
    }
    const rawText = normalizeWhitespace(parts.join("\n"));
    if (!rawText) throw new Error("Kolgimet warning block is empty");
    if (NO_WARNING.test(rawText)) return [];

    return [{
      fingerprint: createHash("sha256").update(`${SOURCE}\n${rawText}`).digest("hex"),
      source: SOURCE,
      sourceUrl: SOURCE_URL,
      rawText,
      publishedAt: null,
    }];
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\t\r ]+/gu, " ").replace(/\n+/gu, "\n").trim();
}
