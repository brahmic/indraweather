import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/telegram.js";

describe("splitMessage", () => {
  it("splits on line boundaries within Telegram limit", () => {
    const chunks = splitMessage(["one", "two", "three"].join("\n"), 8);
    expect(chunks).toEqual(["one\ntwo", "three"]);
    expect(chunks.every((chunk) => chunk.length <= 8)).toBe(true);
  });
});
