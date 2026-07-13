import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/scheduler.js";

describe("Scheduler", () => {
  it("recovers the latest missed slot after a restart when no bulletin exists", async () => {
    const publications = {
      getScheduled: vi.fn(async () => null),
      run: vi.fn(async () => ({ id: "bulletin-1", text: "weather", attachments: [] })),
    };
    const delivery = { broadcast: vi.fn(async () => undefined) };
    const scheduler = new Scheduler(
      [oneMinuteAgoInMoscow()],
      "Europe/Moscow",
      15,
      8,
      publications as never,
      delivery as never,
      { info: vi.fn(), error: vi.fn() } as never,
    );

    await scheduler.start();
    scheduler.stop();

    expect(publications.getScheduled).toHaveBeenCalledOnce();
    expect(publications.run).toHaveBeenCalledWith(expect.objectContaining({ kind: "scheduled" }));
    expect(delivery.broadcast).toHaveBeenCalledOnce();
  });

  it("delivers an already persisted scheduled bulletin without collecting it again", async () => {
    const publication = { id: "bulletin-1", text: "weather", attachments: [] };
    const publications = {
      getScheduled: vi.fn(async () => publication),
      run: vi.fn(),
    };
    const delivery = { broadcast: vi.fn(async () => undefined) };
    const scheduler = new Scheduler(
      [oneMinuteAgoInMoscow()],
      "Europe/Moscow",
      15,
      8,
      publications as never,
      delivery as never,
      { info: vi.fn(), error: vi.fn() } as never,
    );

    await scheduler.start();
    scheduler.stop();

    expect(publications.run).not.toHaveBeenCalled();
    expect(delivery.broadcast).toHaveBeenCalledWith(publication);
  });
});

function oneMinuteAgoInMoscow(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const previous = (hour * 60 + minute + 24 * 60 - 1) % (24 * 60);
  return `${String(Math.floor(previous / 60)).padStart(2, "0")}:${String(previous % 60).padStart(2, "0")}`;
}
