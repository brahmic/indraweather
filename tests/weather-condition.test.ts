import { describe, expect, it } from "vitest";
import { summarizeWeatherCodes, weatherConditionForCode } from "../src/domain/weather-condition.js";

describe("weatherConditionForCode", () => {
  it("maps WMO weather codes to channel-neutral emoji", () => {
    expect(weatherConditionForCode(0)).toMatchObject({ icon: "☀️", label: "ясно" });
    expect(weatherConditionForCode(2)).toMatchObject({ icon: "⛅", label: "переменная облачность" });
    expect(weatherConditionForCode(63)).toMatchObject({ icon: "🌧️", label: "дождь" });
    expect(weatherConditionForCode(95)).toMatchObject({ icon: "⛈️", label: "гроза" });
  });

  it("uses the most frequent condition and favours the more significant one on a tie", () => {
    expect(summarizeWeatherCodes([2, 2, 61])).toMatchObject({ icon: "⛅" });
    expect(summarizeWeatherCodes([2, 61])).toMatchObject({ icon: "🌧️" });
  });
});
