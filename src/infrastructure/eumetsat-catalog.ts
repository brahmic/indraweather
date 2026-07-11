import { z } from "zod";
import { fetchJson } from "./http.js";

const responseSchema = z.object({
  features: z.array(z.object({
    id: z.string(),
    properties: z.object({
      date: z.string(),
      acquisitionInformation: z.array(z.object({
        platform: z.object({ platformShortName: z.string() }),
      })).optional(),
    }),
  })),
});

export type SentinelPlatform = "Sentinel-3A" | "Sentinel-3B";

export interface SentinelProduct {
  id: string;
  platform: SentinelPlatform;
  observedAt: Date;
}

export interface EumetsatCatalogOptions {
  baseUrl: string;
  collectionId: string;
  bbox: [number, number, number, number];
  timeoutMs: number;
  retries: number;
}

export class EumetsatCatalogClient {
  constructor(private readonly options: EumetsatCatalogOptions) {}

  async findProducts(start: Date, end: Date): Promise<SentinelProduct[]> {
    const url = new URL(this.options.baseUrl);
    url.search = new URLSearchParams({
      pi: this.options.collectionId,
      bbox: this.options.bbox.join(","),
      dtstart: start.toISOString(),
      dtend: end.toISOString(),
      format: "json",
      sort: "start,time,0",
    }).toString();
    const response = responseSchema.parse(await fetchJson(url, this.requestOptions()));
    return response.features.flatMap((feature): SentinelProduct[] => {
      const platformName = feature.properties.acquisitionInformation?.[0]
        ?.platform.platformShortName ?? platformFromId(feature.id);
      if (platformName !== "Sentinel-3A" && platformName !== "Sentinel-3B") return [];
      const observedAt = midpoint(feature.properties.date);
      return observedAt ? [{ id: feature.id, platform: platformName, observedAt }] : [];
    }).sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime());
  }

  private requestOptions() {
    return { timeoutMs: this.options.timeoutMs, retries: this.options.retries };
  }
}

function platformFromId(id: string): SentinelPlatform | null {
  if (id.startsWith("S3A_")) return "Sentinel-3A";
  if (id.startsWith("S3B_")) return "Sentinel-3B";
  return null;
}

function midpoint(interval: string): Date | null {
  const [startValue, endValue] = interval.split("/", 2);
  if (!startValue) return null;
  const start = new Date(startValue);
  const end = endValue ? new Date(endValue) : start;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return new Date((start.getTime() + end.getTime()) / 2);
}
