import type {
  BulletinSummary,
  ModelSummary,
  OfficialWarning,
  TideExtreme,
} from "./types.js";
import { circularDifference } from "./analysis.js";

export interface BulletinInput {
  summary: BulletinSummary;
  warnings: OfficialWarning[];
  tides: TideExtreme[];
  previousSummary: BulletinSummary | null;
  nextScheduledAt: Date | null;
  unavailableModels: string[];
  warningSourceUnavailable: boolean;
  timeZone: string;
}

export function renderBulletin(input: BulletinInput): string {
  const generatedAt = new Date(input.summary.generatedAt);
  const lines: string[] = [
    `Кемь — Кандалакша · ${formatDateTime(generatedAt, input.timeZone)}`,
  ];

  if (input.warnings.length > 0) {
    for (const warning of input.warnings) {
      lines.push(
        "",
        "Официальное предупреждение",
        warning.rawText,
        `Источник: ${warning.source} — ${warning.sourceUrl}`,
      );
    }
  }
  if (input.warningSourceUnavailable) {
    lines.push("", "Официальные предупреждения: источник временно недоступен, актуальность не подтверждена.");
  }

  if (input.unavailableModels.length > 0) {
    lines.push("", `Неполные данные: ${input.unavailableModels.join(", ")}.`);
  }

  lines.push("", `Главное: ${renderMainChange(input.summary, input.timeZone)}`);

  for (const point of input.summary.pointSummaries) {
    const gust = point.maxGustMs === null ? "нет данных" : `до ${round(point.maxGustMs)} м/с`;
    const extras: string[] = [];
    if (point.precipitationMm >= 0.1) extras.push(`осадки ${formatNumber(point.precipitationMm)} мм`);
    if (point.minVisibilityKm !== null && point.minVisibilityKm < 10) {
      extras.push(`видимость от ${formatNumber(point.minVisibilityKm)} км`);
    }
    const temperatures = Object.values(point.models).flatMap((model) =>
      model ? [model.minTemperatureC, model.maxTemperatureC] : [],
    ).filter((value): value is number => value !== null);
    if (temperatures.length > 0) {
      extras.push(`температура ${formatSigned(Math.min(...temperatures))}…${formatSigned(Math.max(...temperatures))} °C`);
    }
    lines.push(
      `${point.point.name}: ветер ${round(point.minWindMs)}–${round(point.maxWindMs)} м/с, порывы ${gust}${extras.length ? `; ${extras.join(", ")}` : ""}.`,
    );
  }

  lines.push("", `Поворот ветра: ${renderDirectionTurn(input.summary)}.`);
  lines.push("", `Модели: ${renderAgreement(input.summary)}`);
  lines.push(`Давление: ${renderPressure(input.summary)}.`);
  lines.push(`Следующие 24 часа: ${renderOutlook(input.summary)}.`);
  lines.push(`Прилив: ${renderTide(input.tides, generatedAt, input.timeZone)}`);
  lines.push(`Изменение: ${renderPreviousDifference(input.summary, input.previousSummary)}.`);
  if (input.nextScheduledAt) {
    lines.push(`Следующий выпуск: ${formatDateTime(input.nextScheduledAt, input.timeZone)}.`);
  }
  lines.push("", "Данные: Open-Meteo (ECMWF, NOAA GFS); приливы: Stormglass.");
  return lines.join("\n");
}

function renderDirectionTurn(summary: BulletinSummary): string {
  const turns = summary.pointSummaries.flatMap((point) =>
    Object.values(point.models).flatMap((model) => {
      if (!model || model.directionStartDeg === null || model.directionEndDeg === null) return [];
      return [{
        point: point.point.name,
        start: model.directionStartDeg,
        end: model.directionEndDeg,
        angle: circularDifference(model.directionStartDeg, model.directionEndDeg),
      }];
    }),
  ).filter((turn) => turn.angle >= summary.directionChangeThresholdDeg)
    .sort((left, right) => right.angle - left.angle);
  const turn = turns[0];
  if (!turn) return "заметный поворот не выделяется";
  return `${turn.point}: ${windDirectionLabel(turn.start)} → ${windDirectionLabel(turn.end)}`;
}

function renderOutlook(summary: BulletinSummary): string {
  if (summary.outlook.maxWindMs === null) return "данных недостаточно";
  const gust = summary.outlook.maxGustMs === null
    ? "порывы не определены"
    : `порывы до ${round(summary.outlook.maxGustMs)} м/с`;
  return `ветер до ${round(summary.outlook.maxWindMs)} м/с, ${gust}`;
}

function renderMainChange(summary: BulletinSummary, timeZone: string): string {
  const changes = summary.pointSummaries.flatMap((point) =>
    Object.values(point.models)
      .filter((model): model is ModelSummary => Boolean(model?.windChangeAt))
      .map((model) => ({ point: point.point.name, model })),
  ).sort((left, right) => Math.abs(right.model.windChangeMs) - Math.abs(left.model.windChangeMs));
  const strongest = changes[0];
  if (!strongest || !strongest.model.windChangeAt) {
    const windiest = summary.pointSummaries.reduce((left, right) =>
      left.maxWindMs >= right.maxWindMs ? left : right);
    return `наибольший ветер ожидается в точке «${windiest.point.name}» — до ${round(windiest.maxWindMs)} м/с.`;
  }
  const action = strongest.model.windChangeMs > 0 ? "усиление" : "ослабление";
  return `${action} ветра у точки «${strongest.point}» около ${formatTime(strongest.model.windChangeAt, timeZone)}.`;
}

function renderAgreement(summary: BulletinSummary): string {
  const agreement = summary.agreement;
  if (agreement.reasons.includes("одна из моделей недоступна")) {
    return "сравнение не выполнено, одна из моделей недоступна.";
  }
  if (agreement.agreed) return "в целом согласны.";
  const details = agreement.reasons.join(", ");
  return `${details}.`;
}

function renderPressure(summary: BulletinSummary): string {
  const changes = summary.pointSummaries.flatMap((point) =>
    Object.values(point.models).map((model) => model?.pressureChangeHpa ?? null),
  ).filter((value): value is number => value !== null);
  if (changes.length === 0) return "нет данных";
  const strongest = changes.reduce((left, right) => Math.abs(left) >= Math.abs(right) ? left : right);
  if (Math.abs(strongest) < 1) return "без существенного изменения";
  return `${strongest > 0 ? "рост" : "снижение"} до ${formatNumber(Math.abs(strongest))} гПа за 24 часа`;
}

function renderTide(tides: TideExtreme[], now: Date, timeZone: string): string {
  const sorted = [...tides].sort((left, right) => left.extremeAt.getTime() - right.extremeAt.getTime());
  const future = sorted.filter((item) => item.extremeAt > now);
  const high = future.find((item) => item.type === "high");
  const low = future.find((item) => item.type === "low");
  const next = future[0];
  if (!high || !low || !next) return "данные временно недоступны.";
  const phase = next.type === "high" ? "прилив" : "отлив";
  const minutes = Math.max(0, Math.round((next.extremeAt.getTime() - now.getTime()) / 60_000));
  return `полная вода ${formatDateTime(high.extremeAt, timeZone)}, малая вода ${formatDateTime(low.extremeAt, timeZone)}; сейчас ${phase}, смена примерно через ${formatDuration(minutes)}.`;
}

function renderPreviousDifference(
  current: BulletinSummary,
  previous: BulletinSummary | null,
): string {
  if (!previous) return "нет предыдущего планового выпуска для сравнения";
  const wind = current.overallMaxWindMs - previous.overallMaxWindMs;
  const gust = current.overallMaxGustMs === null || previous.overallMaxGustMs === null
    ? null
    : current.overallMaxGustMs - previous.overallMaxGustMs;
  const changes: string[] = [];
  if (Math.abs(wind) >= 1) {
    changes.push(`максимальный ветер ${wind > 0 ? "вырос" : "снизился"} на ${formatNumber(Math.abs(wind))} м/с`);
  }
  if (gust !== null && Math.abs(gust) >= 1) {
    changes.push(`порывы ${gust > 0 ? "выросли" : "снизились"} на ${formatNumber(Math.abs(gust))} м/с`);
  }
  return changes.length === 0
    ? "существенных изменений относительно предыдущего выпуска нет"
    : changes.join("; ");
}

export function windDirectionLabel(degrees: number): string {
  const labels = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
  return labels[Math.round(((degrees % 360) + 360) % 360 / 45) % 8] ?? "—";
}

export function hasDirectionTurn(model: ModelSummary, threshold: number): boolean {
  return model.directionStartDeg !== null
    && model.directionEndDeg !== null
    && circularDifference(model.directionStartDeg, model.directionEndDeg) >= threshold;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDateTime(date: Date, timeZone: string): string {
  return `${new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)} МСК`;
}

function formatTime(date: Date, timeZone: string): string {
  return `${new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)} МСК`;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder} мин`;
  return remainder === 0 ? `${hours} ч` : `${hours} ч ${remainder} мин`;
}

function round(value: number): number {
  return Math.round(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}
