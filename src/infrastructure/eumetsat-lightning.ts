import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";
import { fetchBinary, fetchJson } from "./http.js";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const searchResponseSchema = z.object({
  features: z.array(z.object({
    id: z.string().min(1),
    properties: z.object({ date: z.string().min(1) }),
  })),
});

export interface LightningFlash {
  observedAt: Date;
  latitude: number;
  longitude: number;
}

export interface EumetsatLightningOptions {
  consumerKey: string;
  consumerSecret: string;
  collectionId: string;
  searchUrl: string;
  downloadUrl: string;
  timeoutMs: number;
  retries: number;
  maxProductBytes: number;
}

interface Product {
  id: string;
  observedAt: Date;
}

export class EumetsatLightningClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: EumetsatLightningOptions) {}

  async getFlashes(
    start: Date,
    end: Date,
    bbox: [number, number, number, number],
  ): Promise<LightningFlash[]> {
    // Data Store files cover ten-minute slices. Include the preceding slice so
    // flashes from a product overlapping the requested start are not missed.
    const products = await this.findProducts(new Date(start.getTime() - 10 * 60_000), end);
    if (products.length === 0) return [];
    const flashes: LightningFlash[] = [];
    for (const product of products) {
      flashes.push(...await this.readProduct(product, bbox));
    }
    return deduplicateFlashes(flashes).filter((flash) =>
      flash.observedAt >= start && flash.observedAt <= end,
    ).sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  }

  private async findProducts(start: Date, end: Date): Promise<Product[]> {
    const url = new URL(this.options.searchUrl);
    url.search = new URLSearchParams({
      pi: this.options.collectionId,
      dtstart: start.toISOString(),
      dtend: end.toISOString(),
      format: "json",
      sort: "start,time,0",
    }).toString();
    const response = searchResponseSchema.parse(await fetchJson(url, this.requestOptions()));
    return response.features.flatMap((feature): Product[] => {
      const observedAt = midpoint(feature.properties.date);
      return observedAt ? [{ id: feature.id, observedAt }] : [];
    }).sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  }

  private async readProduct(
    product: Product,
    bbox: [number, number, number, number],
  ): Promise<LightningFlash[]> {
    const token = await this.getToken();
    const url = new URL(
      `collections/${encodeURIComponent(this.options.collectionId)}/products/${encodeURIComponent(product.id)}`,
      `${this.options.downloadUrl.replace(/\/$/u, "")}/`,
    );
    const result = await fetchBinary(url, {
      ...this.requestOptions(),
      headers: { Authorization: `Bearer ${token}` },
    }, this.options.maxProductBytes);
    const files = extractNetcdfFiles(result.data);
    const flashes: LightningFlash[] = [];
    for (const file of files) {
      flashes.push(...await readFlashes(file.name, file.data, bbox));
    }
    return flashes;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const credentials = Buffer.from(
      `${this.options.consumerKey}:${this.options.consumerSecret}`,
    ).toString("base64");
    const response = tokenSchema.parse(await fetchJson("https://api.eumetsat.int/token", {
      ...this.requestOptions(),
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }));
    this.token = {
      value: response.access_token,
      expiresAt: Date.now() + Math.max(1, response.expires_in - 60) * 1000,
    };
    return this.token.value;
  }

  private requestOptions() {
    return { timeoutMs: this.options.timeoutMs, retries: this.options.retries };
  }
}

async function readFlashes(
  name: string,
  data: Uint8Array,
  bbox: [number, number, number, number],
): Promise<LightningFlash[]> {
  const directory = await mkdtemp(join(tmpdir(), "indra-lightning-"));
  const filePath = join(directory, name);
  try {
    await writeFile(filePath, data);
    const h5wasm = await import("h5wasm/node");
    await h5wasm.ready;
    const file = new h5wasm.File(filePath, "r");
    try {
      const times = numericVariable(file.get("flash_time"), "flash_time");
      const latitudes = numericVariable(file.get("latitude"), "latitude");
      const longitudes = numericVariable(file.get("longitude"), "longitude");
      if (times.values.length !== latitudes.values.length || times.values.length !== longitudes.values.length) {
        throw new Error(`LI product ${name} contains incompatible flash arrays`);
      }
      const units = stringAttribute(file.get("flash_time"), "units");
      const toDate = createTimeConverter(units);
      const [west, south, east, north] = bbox;
      return times.values.flatMap((value, index): LightningFlash[] => {
        const rawLatitude = latitudes.values[index];
        const rawLongitude = longitudes.values[index];
        if (value === undefined || rawLatitude === undefined || rawLongitude === undefined
          || isFillValue(value, times) || isFillValue(rawLatitude, latitudes) || isFillValue(rawLongitude, longitudes)) {
          return [];
        }
        const latitude = decodeValue(rawLatitude, latitudes);
        const longitude = decodeValue(rawLongitude, longitudes);
        const observedAt = toDate(decodeValue(value, times));
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
          || latitude < south || latitude > north || longitude < west || longitude > east) {
          return [];
        }
        return Number.isNaN(observedAt.getTime()) ? [] : [{
          observedAt,
          latitude,
          longitude,
        }];
      });
    } finally {
      file.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface NumericVariable {
  values: number[];
  scaleFactor: number;
  addOffset: number;
  fillValue: number | null;
}

function numericVariable(entity: unknown, name: string): NumericVariable {
  if (!entity || typeof entity !== "object" || !("value" in entity)) {
    throw new Error(`LI product is missing ${name}`);
  }
  const value = entity.value;
  if (!ArrayBuffer.isView(value)) throw new Error(`LI product ${name} is not numeric`);
  if (value instanceof DataView) throw new Error(`LI product ${name} is not numeric`);
  const values = value as unknown as { length: number; [index: number]: number | bigint };
  return {
    values: Array.from({ length: values.length }, (_, index) => Number(values[index])),
    scaleFactor: numberAttribute(entity, "scale_factor") ?? 1,
    addOffset: numberAttribute(entity, "add_offset") ?? 0,
    fillValue: numberAttribute(entity, "_FillValue"),
  };
}

function stringAttribute(entity: unknown, name: string): string | null {
  if (!entity || typeof entity !== "object" || !("attrs" in entity)) return null;
  const attributes = entity.attrs as Record<string, unknown>;
  if (!attributes || typeof attributes !== "object" || !(name in attributes)) return null;
  const attribute = attributes[name];
  if (!attribute || typeof attribute !== "object" || !("value" in attribute)) return null;
  return typeof attribute.value === "string" ? attribute.value : null;
}

function numberAttribute(entity: unknown, name: string): number | null {
  if (!entity || typeof entity !== "object" || !("attrs" in entity)) return null;
  const attributes = entity.attrs as Record<string, unknown>;
  if (!attributes || typeof attributes !== "object" || !(name in attributes)) return null;
  const attribute = attributes[name];
  if (!attribute || typeof attribute !== "object" || !("value" in attribute)) return null;
  const value = attribute.value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const first = (value as unknown as { [index: number]: number | bigint })[0];
    const number = typeof first === "bigint" ? Number(first) : first;
    return typeof number === "number" && Number.isFinite(number) ? number : null;
  }
  return null;
}

function isFillValue(value: number, variable: NumericVariable): boolean {
  return variable.fillValue !== null && value === variable.fillValue;
}

function decodeValue(value: number, variable: NumericVariable): number {
  return value * variable.scaleFactor + variable.addOffset;
}

function createTimeConverter(units: string | null): (value: number) => Date {
  const match = /^(milliseconds|seconds|minutes|hours) since (.+)$/iu.exec(units ?? "");
  if (!match?.[1] || !match[2]) {
    throw new Error(`Unsupported LI flash_time units: ${units ?? "missing"}`);
  }
  const epoch = parseNetcdfDate(match[2]);
  if (Number.isNaN(epoch.getTime())) throw new Error(`Invalid LI flash_time epoch: ${match[2]}`);
  const unitMs: Record<string, number> = {
    milliseconds: 1,
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
  };
  const multiplier = unitMs[match[1].toLocaleLowerCase("en-US")];
  if (!multiplier) throw new Error(`Unsupported LI flash_time unit: ${match[1]}`);
  return (value) => new Date(epoch.getTime() + value * multiplier);
}

function parseNetcdfDate(value: string): Date {
  const normalized = value.trim().replace(" UTC", "Z");
  if (/Z$/u.test(normalized)) return new Date(normalized.replace(" ", "T"));
  return new Date(`${normalized.replace(" ", "T")}Z`);
}

function extractNetcdfFiles(data: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  if (isHdf5(data)) return [{ name: "lightning.nc", data }];
  if (data[0] !== 0x50 || data[1] !== 0x4b) {
    throw new Error("EUMETSAT LI download is not a NetCDF-4 or ZIP product");
  }
  const files = Object.entries(unzipSync(data))
    .filter(([name, value]) => /\.nc(?:4)?$/iu.test(name) && isHdf5(value))
    .map(([name, value]) => ({ name: name.replaceAll("/", "_"), data: value }));
  if (files.length === 0) throw new Error("EUMETSAT LI ZIP contains no NetCDF-4 files");
  return files;
}

function isHdf5(data: Uint8Array): boolean {
  return data.length >= 8
    && data[0] === 0x89 && data[1] === 0x48 && data[2] === 0x44 && data[3] === 0x46
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
}

function midpoint(interval: string): Date | null {
  const [startValue, endValue] = interval.split("/", 2);
  if (!startValue) return null;
  const start = new Date(startValue);
  const end = endValue ? new Date(endValue) : start;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return new Date((start.getTime() + end.getTime()) / 2);
}

function deduplicateFlashes(flashes: LightningFlash[]): LightningFlash[] {
  const unique = new Map<string, LightningFlash>();
  for (const flash of flashes) {
    const key = `${flash.observedAt.toISOString()}:${flash.latitude.toFixed(4)}:${flash.longitude.toFixed(4)}`;
    unique.set(key, flash);
  }
  return [...unique.values()];
}
