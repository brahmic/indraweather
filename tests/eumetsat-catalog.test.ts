import { afterEach, describe, expect, it, vi } from "vitest";
import { EumetsatCatalogClient } from "../src/infrastructure/eumetsat-catalog.js";

afterEach(() => vi.unstubAllGlobals());

describe("EumetsatCatalogClient", () => {
  it("normalizes products and uses the sensing interval midpoint", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      features: [{
        id: "S3A_TEST.SEN3",
        properties: {
          date: "2026-07-10T09:07:00Z/2026-07-10T09:11:00Z",
          acquisitionInformation: [{ platform: { platformShortName: "Sentinel-3A" } }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EumetsatCatalogClient({
      baseUrl: "https://example.test/search",
      collectionId: "collection",
      bbox: [31.4, 65.6, 35.8, 67.4],
      timeoutMs: 1000,
      retries: 0,
    });

    const products = await client.findProducts(
      new Date("2026-07-10T00:00:00Z"),
      new Date("2026-07-11T00:00:00Z"),
    );

    expect(products[0]?.observedAt.toISOString()).toBe("2026-07-10T09:09:00.000Z");
    expect(products[0]?.platform).toBe("Sentinel-3A");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("bbox")).toBe("31.4,65.6,35.8,67.4");
    expect(url.searchParams.get("pi")).toBe("collection");
  });
});
