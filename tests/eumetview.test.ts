import { afterEach, describe, expect, it, vi } from "vitest";
import { EumetviewClient } from "../src/infrastructure/eumetview.js";

afterEach(() => vi.unstubAllGlobals());

describe("EumetviewClient", () => {
  it("reads the latest layer timestamp and downloads a bounded PNG", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("request") === "GetCapabilities") {
        return new Response(`
          <WMS_Capabilities>
            <Layer>
              <Name>mtg_fd:rgb_truecolour</Name>
              <Dimension name="time" default="2026-07-11T02:30:00Z" />
            </Layer>
          </WMS_Capabilities>
        `, { status: 200, headers: { "content-type": "application/xml" } });
      }
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(png.length) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new EumetviewClient({
      baseUrl: "https://example.test/wms",
      wfsUrl: "https://example.test/wfs",
      bbox: [30, 64, 36, 68],
      width: 1000,
      height: 800,
      timeoutMs: 1000,
      retries: 0,
      maxImageBytes: 1000,
    });

    const metadata = await client.getLatestMetadata(client.dayLayer);
    const image = await client.getImage(client.dayLayer, metadata.observedAt);

    expect(metadata.observedAt.toISOString()).toBe("2026-07-11T02:30:00.000Z");
    expect(image.data).toEqual(png);
    const imageUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(imageUrl.searchParams.get("bbox")).toBe("30,64,36,68");
    expect(imageUrl.searchParams.get("layers")).toBe("mtg_fd:rgb_truecolour");
    expect(imageUrl.searchParams.get("time")).toBe("2026-07-11T02:30:00.000Z");
  });

  it("loads and normalizes WFS coastline GeoJSON", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: {
          type: "MultiLineString",
          coordinates: [[[30, 64], [33, 66], [36, 68]]],
        },
        properties: {},
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EumetviewClient({
      baseUrl: "https://example.test/wms",
      wfsUrl: "https://example.test/wfs",
      bbox: [30, 64, 36, 68],
      width: 1000,
      height: 800,
      timeoutMs: 1000,
      retries: 0,
      maxImageBytes: 1000,
    });

    expect(await client.getCoastline()).toEqual([[[30, 64], [33, 66], [36, 68]]]);
    expect(await client.getCoastline()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/wfs");
    expect(url.searchParams.get("bbox")).toBe("30,64,36,68,EPSG:4326");
  });

  it("rejects an oversized response before reading it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "1001" },
    })));
    const client = new EumetviewClient({
      baseUrl: "https://example.test/wms",
      wfsUrl: "https://example.test/wfs",
      bbox: [30, 64, 36, 68],
      width: 1000,
      height: 800,
      timeoutMs: 1000,
      retries: 0,
      maxImageBytes: 1000,
    });
    await expect(client.getImage(client.dayLayer, new Date())).rejects.toThrow(/exceeds/u);
  });
});
