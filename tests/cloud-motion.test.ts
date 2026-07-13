import { describe, expect, it } from "vitest";
import { formatPersonalCloudMotionStatus } from "../src/delivery/cloud-motion.js";

describe("formatPersonalCloudMotionStatus", () => {
  it("uses singular wording when one animation is ready", () => {
    expect(formatPersonalCloudMotionStatus(["queued", "unavailable"]))
      .toContain("Собираю анимацию");
  });

  it("uses plural wording when both animations are ready", () => {
    expect(formatPersonalCloudMotionStatus(["queued", "cached"]))
      .toContain("Собираю анимации");
  });

  it("explains when neither animation can be prepared", () => {
    expect(formatPersonalCloudMotionStatus(["unavailable", "unavailable"]))
      .toContain("пока недоступны");
  });
});
