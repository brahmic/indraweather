import * as cheerio from "cheerio";
import { z } from "zod";
import { fetchBinary, fetchJson, fetchText } from "./http.js";

const geoJsonSchema = z.object({
  features: z.array(z.object({
    geometry: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("LineString"),
        coordinates: z.array(z.array(z.number()).min(2)),
      }),
      z.object({
        type: z.literal("MultiLineString"),
        coordinates: z.array(z.array(z.array(z.number()).min(2))),
      }),
    ]).nullable(),
  })),
});

export type CoastlinePath = Array<[longitude: number, latitude: number]>;

export interface SatelliteLayer {
  name: string;
  mode: "day" | "night";
  style?: string;
}

export interface EumetviewOptions {
  baseUrl: string;
  wfsUrl: string;
  bbox: [number, number, number, number];
  width: number;
  height: number;
  timeoutMs: number;
  retries: number;
  maxImageBytes: number;
  dayLayer?: SatelliteLayer;
  nightLayer?: SatelliteLayer;
}

export class EumetviewClient {
  readonly dayLayer: SatelliteLayer;
  readonly nightLayer: SatelliteLayer;
  private coastline: CoastlinePath[] | null = null;

  constructor(private readonly options: EumetviewOptions) {
    this.dayLayer = options.dayLayer ?? {
      name: "mtg_fd:rgb_truecolour",
      mode: "day",
    };
    this.nightLayer = options.nightLayer ?? {
      name: "mtg_fd:ir105_hrfi",
      mode: "night",
      style: "mtg_fd:mtg_fd_ir105_hrfi_grayscale",
    };
  }

  async getLatestMetadata(layer: SatelliteLayer): Promise<{ observedAt: Date }> {
    const url = new URL(this.options.baseUrl);
    url.search = new URLSearchParams({
      service: "WMS",
      version: "1.3.0",
      request: "GetCapabilities",
    }).toString();
    const xml = await fetchText(url, this.requestOptions());
    const $ = cheerio.load(xml, { xmlMode: true });
    const matchingLayer = $("Layer").filter((_, element) =>
      $(element).children("Name").first().text() === layer.name).first();
    const timestamp = matchingLayer.children('Dimension[name="time"]').attr("default");
    if (!timestamp) throw new Error(`EUMETView layer ${layer.name} has no latest timestamp`);
    const observedAt = new Date(timestamp);
    if (Number.isNaN(observedAt.getTime())) {
      throw new Error(`Invalid EUMETView timestamp for ${layer.name}: ${timestamp}`);
    }
    return { observedAt };
  }

  async getImage(
    layer: SatelliteLayer,
    observedAt: Date,
  ): Promise<{ data: Uint8Array; contentType: "image/png" }> {
    const url = new URL(this.options.baseUrl);
    url.search = new URLSearchParams({
      service: "WMS",
      version: "1.1.1",
      request: "GetMap",
      layers: layer.name,
      styles: layer.style ?? "",
      srs: "EPSG:4326",
      bbox: this.options.bbox.join(","),
      width: String(this.options.width),
      height: String(this.options.height),
      format: "image/png",
      time: observedAt.toISOString(),
    }).toString();
    const result = await fetchBinary(url, this.requestOptions(), this.options.maxImageBytes);
    if (result.contentType !== "image/png") {
      throw new Error(`Unexpected EUMETView content type: ${result.contentType}`);
    }
    return { data: result.data, contentType: "image/png" };
  }

  async getCoastline(): Promise<CoastlinePath[]> {
    if (this.coastline) return this.coastline;
    const url = new URL(this.options.wfsUrl);
    url.search = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: "backgrounds:ne_10m_coastline",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      bbox: `${this.options.bbox.join(",")},EPSG:4326`,
    }).toString();
    const geoJson = geoJsonSchema.parse(await fetchJson(url, this.requestOptions()));
    const coastline = geoJson.features.flatMap((feature): CoastlinePath[] => {
      const geometry = feature.geometry;
      if (!geometry) return [];
      const lines = geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.coordinates;
      return lines.map((line) => line.map((coordinate) => [
        coordinate[0] ?? 0,
        coordinate[1] ?? 0,
      ]));
    }).filter((line) => line.length > 1);
    if (coastline.length === 0) throw new Error("EUMETView coastline response is empty");
    this.coastline = coastline;
    return coastline;
  }

  private requestOptions() {
    return { timeoutMs: this.options.timeoutMs, retries: this.options.retries };
  }
}
