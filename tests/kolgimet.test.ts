import { afterEach, describe, expect, it, vi } from "vitest";
import { KolgimetClient } from "../src/infrastructure/kolgimet.js";

afterEach(() => vi.unstubAllGlobals());

describe("KolgimetClient", () => {
  it("does not create a warning from the official no-warning message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <main>
        <h2>Штормовое предупреждение</h2>
        <p>В зоне ответственности ФГБУ "Мурманское УГМС" опасных явлений погоды не ожидается.</p>
        <h2>Синоптическая карта</h2>
      </main>
    `, { status: 200 })));
    const warnings = await new KolgimetClient(1000, 0).getWarnings();
    expect(warnings).toEqual([]);
  });

  it("preserves warning text and adds a stable fingerprint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <main>
        <h2>Штормовое предупреждение</h2>
        <p>Ожидается усиление ветра до 25 м/с.</p>
        <h2>Синоптическая карта</h2>
      </main>
    `, { status: 200 })));
    const warnings = await new KolgimetClient(1000, 0).getWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.rawText).toBe("Ожидается усиление ветра до 25 м/с.");
    expect(warnings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
