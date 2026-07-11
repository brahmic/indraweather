import * as cheerio from "cheerio";
import { fetchBinary, fetchText } from "./http.js";

export interface SatelliteLayer {
  name: string;
  mode: "day" | "night";
  style?: string;
}

export interface EumetviewOptions {
  baseUrl: string;
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
    const layers = [layer.name, "backgrounds:ne_10m_coastline"];
    const styles = [layer.style ?? "", "line"];
    url.search = new URLSearchParams({
      service: "WMS",
      version: "1.1.1",
      request: "GetMap",
      layers: layers.join(","),
      styles: styles.join(","),
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

  private requestOptions() {
    return { timeoutMs: this.options.timeoutMs, retries: this.options.retries };
  }
}
