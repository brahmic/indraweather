import { fetchText } from "./http.js";
import type { SentinelPlatform } from "./eumetsat-catalog.js";

export interface TleRecord {
  platform: SentinelPlatform;
  line1: string;
  line2: string;
}

export interface EumetsatTleOptions {
  s3aUrl: string;
  s3bUrl: string;
  timeoutMs: number;
  retries: number;
  cacheMinutes?: number;
}

export class EumetsatTleClient {
  private cached: { records: TleRecord[]; cachedAt: Date } | null = null;

  constructor(private readonly options: EumetsatTleOptions) {}

  async getRecords(now = new Date()): Promise<TleRecord[]> {
    const cacheMinutes = this.options.cacheMinutes ?? 360;
    if (this.cached && now.getTime() - this.cached.cachedAt.getTime() < cacheMinutes * 60_000) {
      return this.cached.records;
    }
    const [s3a, s3b] = await Promise.all([
      fetchText(this.options.s3aUrl, this.requestOptions()),
      fetchText(this.options.s3bUrl, this.requestOptions()),
    ]);
    const records = [
      ...parseTleJavaScript(s3a, "Sentinel-3A"),
      ...parseTleJavaScript(s3b, "Sentinel-3B"),
    ];
    if (records.length === 0) throw new Error("EUMETSAT TLE response contains no records");
    this.cached = { records, cachedAt: now };
    return records;
  }

  private requestOptions() {
    return { timeoutMs: this.options.timeoutMs, retries: this.options.retries };
  }
}

export function parseTleJavaScript(source: string, platform: SentinelPlatform): TleRecord[] {
  const lines = [...source.matchAll(/=[ \t]*"([12] [^"]+)"/gu)].map((match) => match[1]);
  const records: TleRecord[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const line1 = lines[index];
    const line2 = lines[index + 1];
    if (line1?.startsWith("1 ") && line2?.startsWith("2 ")) {
      records.push({ platform, line1, line2 });
    }
  }
  return records;
}
