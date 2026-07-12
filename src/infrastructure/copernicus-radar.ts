import { z } from "zod";
import type { MapViewport } from "../domain/map-viewport.js";

const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number().positive() });
const catalogSchema = z.object({
  features: z.array(z.object({ properties: z.object({ datetime: z.string() }) })),
});

export interface CopernicusRadarOptions {
  clientId: string;
  clientSecret: string;
  bbox: [number, number, number, number];
  width: number;
  height: number;
  lookbackDays: number;
  timeoutMs: number;
  maxImageBytes: number;
}

export interface CopernicusRadarImage {
  data: Uint8Array;
  observedAt: Date;
}

export class CopernicusRadarClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: CopernicusRadarOptions) {}

  async getLatest(now = new Date(), viewport?: MapViewport): Promise<CopernicusRadarImage> {
    const bbox = viewport?.bbox ?? this.options.bbox;
    const width = viewport?.width ?? this.options.width;
    const height = viewport?.height ?? this.options.height;
    const token = await this.getToken();
    const observedAt = await this.getLatestObservation(token, now, bbox);
    const from = new Date(observedAt.getTime() - 60_000);
    const to = new Date(observedAt.getTime() + 60_000);
    const response = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        input: {
          bounds: {
            bbox,
            properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" },
          },
          data: [{
            type: "sentinel-1-grd",
            dataFilter: {
              timeRange: { from: from.toISOString(), to: to.toISOString() },
              mosaickingOrder: "mostRecent",
              acquisitionMode: "IW",
              polarization: "DV",
            },
          }],
        },
        output: {
          width,
          height,
          responses: [{ identifier: "default", format: { type: "image/png" } }],
        },
        evalscript: EVALSCRIPT,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`Copernicus radar request failed: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > this.options.maxImageBytes) {
      throw new Error(`Copernicus radar image has invalid size: ${data.byteLength}`);
    }
    return { data, observedAt };
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const response = await fetch("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`Copernicus authentication failed: HTTP ${response.status}`);
    const token = tokenSchema.parse(await response.json());
    this.token = { value: token.access_token, expiresAt: Date.now() + (token.expires_in - 60) * 1000 };
    return token.access_token;
  }

  private async getLatestObservation(
    token: string,
    now: Date,
    bbox: [number, number, number, number],
  ): Promise<Date> {
    const from = new Date(now.getTime() - this.options.lookbackDays * 86_400_000);
    const response = await fetch("https://sh.dataspace.copernicus.eu/catalog/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        collections: ["sentinel-1-grd"],
        bbox,
        datetime: `${from.toISOString()}/${now.toISOString()}`,
        limit: 100,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Copernicus radar catalogue failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const features = catalogSchema.parse(await response.json()).features;
    const feature = features
      .map((item) => ({ item, observedAt: new Date(item.properties.datetime) }))
      .filter((item) => !Number.isNaN(item.observedAt.getTime()))
      .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime())[0]?.item;
    if (!feature) throw new Error(`No Sentinel-1 radar scenes in the last ${this.options.lookbackDays} days`);
    const observedAt = new Date(feature.properties.datetime);
    if (Number.isNaN(observedAt.getTime())) throw new Error("Copernicus radar scene has invalid timestamp");
    return observedAt;
  }
}

const EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: ["VV", "VH", "dataMask"], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  if (sample.dataMask === 0) return [0, 0, 0, 0];
  const db = 10 * Math.log10(Math.max(sample.VV, 0.000001));
  const value = Math.max(0, Math.min(1, (db + 25) / 20));
  return [value, value, value, 1];
}`;
