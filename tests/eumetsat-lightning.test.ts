import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EumetsatLightningClient } from "../src/infrastructure/eumetsat-lightning.js";

describe("EumetsatLightningClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes scaled NetCDF coordinates and keeps only the requested interval and map extent", async () => {
    const product = await lightningProduct();
    const fetch = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.startsWith("https://api.example/search")) {
        return jsonResponse({
          features: [{
            id: "li-product-1",
            properties: { date: "2026-07-13T10:00:00Z/2026-07-13T10:10:00Z" },
          }],
        });
      }
      if (url === "https://api.eumetsat.int/token") {
        return jsonResponse({ access_token: "temporary-access-token", expires_in: 600 });
      }
      if (url.includes("/collections/EO%3AEUM%3ADAT%3A0691/products/li-product-1")) {
        const body = new Uint8Array(product).buffer;
        return new Response(body, { headers: { "content-type": "application/x-netcdf" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const client = new EumetsatLightningClient({
      consumerKey: "consumer-key",
      consumerSecret: "consumer-secret",
      collectionId: "EO:EUM:DAT:0691",
      searchUrl: "https://api.example/search",
      downloadUrl: "https://api.example/download",
      timeoutMs: 1_000,
      retries: 0,
      maxProductBytes: 1_000_000,
    });

    const flashes = await client.getFlashes(
      new Date("2026-07-13T10:00:00Z"),
      new Date("2026-07-13T10:30:00Z"),
      [30, 64, 36, 68],
    );

    expect(flashes).toEqual([expect.objectContaining({
      observedAt: new Date("2026-07-13T10:05:00Z"),
      latitude: 64.999,
      longitude: 34.001,
    })]);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get("dtstart"))
      .toBe("2026-07-13T09:50:00.000Z");
    expect(fetch.mock.calls).toHaveLength(3);
  });
});

async function lightningProduct(): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "indra-li-test-"));
  const path = join(directory, "lightning.nc");
  try {
    const h5wasm = await import("h5wasm/node");
    await h5wasm.ready;
    const file = new h5wasm.File(path, "w");
    try {
      const variables = file.create_group("data");
      const times = variables.create_dataset({
        name: "flash_time",
        data: new Float64Array([
          secondsSince2000("2026-07-13T10:05:00Z"),
          secondsSince2000("2026-07-13T09:45:00Z"),
        ]),
      });
      times.create_attribute("units", "seconds since 2000-01-01 00:00:00.0");
      const latitudes = variables.create_dataset({ name: "latitude", data: new Int16Array([23_636, 25_000]) });
      latitudes.create_attribute("scale_factor", 0.00275);
      latitudes.create_attribute("_FillValue", -32_768);
      const longitudes = variables.create_dataset({ name: "longitude", data: new Uint16Array([12_364, 12_364]) });
      longitudes.create_attribute("scale_factor", 0.00275);
      longitudes.create_attribute("_FillValue", 65_535);
    } finally {
      file.close();
    }
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function secondsSince2000(value: string): number {
  return (new Date(value).getTime() - Date.UTC(2000, 0, 1)) / 1_000;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
