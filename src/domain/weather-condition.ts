export interface WeatherCondition {
  id: string;
  icon: string;
  label: string;
  priority: number;
}

export type WeatherConditionGroup = "fair" | "cloud" | "fog" | "rain" | "snow" | "thunderstorm";

/** Maps Open-Meteo's WMO weather interpretation codes to channel-neutral emoji. */
export function weatherConditionForCode(code: number | null | undefined): WeatherCondition | null {
  switch (code) {
    case 0:
      return condition("clear", "☀️", "ясно", 1);
    case 1:
      return condition("mostly-clear", "🌤️", "преимущественно ясно", 2);
    case 2:
      return condition("partly-cloudy", "⛅", "переменная облачность", 3);
    case 3:
      return condition("overcast", "☁️", "облачно", 4);
    case 45:
    case 48:
      return condition("fog", "🌫️", "туман", 5);
    case 51:
    case 53:
    case 55:
      return condition("drizzle", "🌦️", "морось", 6);
    case 56:
    case 57:
      return condition("freezing-drizzle", "🌧️", "ледяная морось", 7);
    case 61:
    case 63:
    case 65:
      return condition("rain", "🌧️", "дождь", 8);
    case 66:
    case 67:
      return condition("freezing-rain", "🌧️", "ледяной дождь", 9);
    case 71:
    case 73:
    case 75:
    case 77:
      return condition("snow", "🌨️", "снег", 8);
    case 80:
    case 81:
    case 82:
      return condition("showers", "🌦️", "ливни", 9);
    case 85:
    case 86:
      return condition("snow-showers", "🌨️", "снегопад", 9);
    case 95:
    case 96:
    case 99:
      return condition("thunderstorm", "⛈️", "гроза", 10);
    default:
      return null;
  }
}

export function summarizeWeatherCodes(codes: Array<number | null | undefined>): WeatherCondition | null {
  const counts = new Map<string, { condition: WeatherCondition; count: number }>();
  for (const code of codes) {
    const condition = weatherConditionForCode(code);
    if (!condition) continue;
    const current = counts.get(condition.id);
    if (current) {
      current.count += 1;
    } else {
      counts.set(condition.id, { condition, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || right.condition.priority - left.condition.priority)[0]
    ?.condition ?? null;
}

export function weatherConditionGroup(condition: WeatherCondition | null | undefined): WeatherConditionGroup | null {
  if (!condition) return null;
  switch (condition.id) {
    case "clear":
    case "mostly-clear":
    case "partly-cloudy":
      return "fair";
    case "overcast":
      return "cloud";
    case "fog":
      return "fog";
    case "drizzle":
    case "freezing-drizzle":
    case "rain":
    case "freezing-rain":
    case "showers":
      return "rain";
    case "snow":
    case "snow-showers":
      return "snow";
    case "thunderstorm":
      return "thunderstorm";
    default:
      return null;
  }
}

function condition(id: string, icon: string, label: string, priority: number): WeatherCondition {
  return { id, icon, label, priority };
}
