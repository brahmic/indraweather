import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("builds an encoded PostgreSQL URL from Docker connection fields", () => {
    const config = loadConfig({
      DATABASE_HOST: "postgres",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "indra",
      DATABASE_USER: "indra",
      DATABASE_PASSWORD: "strong:p@ss/word",
    });

    expect(config.databaseUrl).toBe(
      "postgresql://indra:strong%3Ap%40ss%2Fword@postgres:5432/indra",
    );
  });

  it("still supports a direct URL outside Docker", () => {
    const databaseUrl = "postgres://user:password@localhost:5432/test";
    expect(loadConfig({ DATABASE_URL: databaseUrl }).databaseUrl).toBe(databaseUrl);
  });

  it("fails when no database connection is configured", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL|DATABASE_HOST/u);
  });
});
