import { describe, expect, it, vi } from "vitest";
import { BoundedTtlCache } from "../src/application/bounded-ttl-cache.js";

describe("BoundedTtlCache", () => {
  it("shares concurrent loads, expires entries, and evicts the least recently used entry", async () => {
    const cache = new BoundedTtlCache<string>(60_000, 2);
    const firstLoad = vi.fn(async () => "first");
    const now = new Date("2026-07-13T10:00:00Z");

    const [first, duplicate] = await Promise.all([
      cache.getOrLoad("first", now, firstLoad),
      cache.getOrLoad("first", now, firstLoad),
    ]);
    await cache.getOrLoad("second", now, async () => "second");
    await cache.getOrLoad("first", now, async () => "unexpected");
    await cache.getOrLoad("third", now, async () => "third");

    expect(first).toBe("first");
    expect(duplicate).toBe("first");
    expect(firstLoad).toHaveBeenCalledOnce();
    await expect(cache.getOrLoad("second", now, async () => "reloaded")).resolves.toBe("reloaded");
    await expect(cache.getOrLoad("first", new Date(now.getTime() + 60_000), async () => "expired"))
      .resolves.toBe("expired");
  });
});
