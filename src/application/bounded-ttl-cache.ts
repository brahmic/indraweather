interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Bounded in-memory cache with TTL and one shared loader for concurrent misses. */
export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  async getOrLoad(key: string, now: Date, load: () => Promise<T>): Promise<T> {
    this.prune(now.getTime());
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.value;
    }

    const active = this.pending.get(key);
    if (active) return active;

    const request = load().then((value) => {
      this.entries.set(key, { value, expiresAt: now.getTime() + this.ttlMs });
      this.trim();
      return value;
    }).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }
}
