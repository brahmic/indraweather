import { z } from "zod";
import type { TideExtreme } from "../domain/types.js";
import { fetchJson } from "./http.js";

const responseSchema = z.object({
  data: z.array(z.object({
    height: z.number().nullable().optional(),
    time: z.string(),
    type: z.enum(["high", "low"]),
  })),
  meta: z.object({
    station: z.object({ name: z.string().optional() }).optional(),
  }).passthrough(),
});

export class StormglassClient {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly retries: number,
  ) {}

  async getExtremes(start: Date, end: Date): Promise<TideExtreme[]> {
    const url = new URL("https://api.stormglass.io/v2/tide/extremes/point");
    url.searchParams.set("lat", "67.133");
    url.searchParams.set("lng", "32.425");
    url.searchParams.set("start", start.toISOString());
    url.searchParams.set("end", end.toISOString());
    url.searchParams.set("datum", "MSL");
    const raw = await fetchJson(url, {
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      headers: { Authorization: this.apiKey },
    });
    const response = responseSchema.parse(raw);
    return response.data.map((item) => ({
      extremeAt: new Date(item.time),
      type: item.type,
      heightM: item.height ?? null,
      source: "Stormglass",
      stationName: response.meta.station?.name ?? "Кандалакша",
    }));
  }
}
