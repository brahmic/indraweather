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
    expect(imageUrl.searchParams.get("layers")).toContain("backgrounds:ne_10m_coastline");
    expect(imageUrl.searchParams.get("time")).toBe("2026-07-11T02:30:00.000Z");
  });

  it("rejects an oversized response before reading it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "1001" },
    })));
    const client = new EumetviewClient({
      baseUrl: "https://example.test/wms",
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
