import type {
  BulletinSummary,
  ModelSummary,
  OfficialWarning,
  TideExtreme,
  WeatherModel,
} from "./types.js";
import { circularDifference } from "./analysis.js";

const AGREEMENT_LABELS: Record<string, string> = {
  "расходятся по силе ветра": "сила ветра",
  "расходятся по порывам": "порывы",
  "расходятся по направлению": "направление",
  "расходятся по наличию заметного изменения ветра": "наличие изменения ветра",
  "расходятся по времени изменения": "время изменения ветра",
};

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
    "Кемь — Кандалакша · гидрометеосводка",
    `Сформировано: ${formatDateTime(generatedAt, input.timeZone)} · прогноз на ${input.summary.horizonHours} часа`,
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

  lines.push(
    "",
    "Главное",
    renderMainChange(input.summary, input.timeZone),
    `Верхняя граница моделей: ветер до ${round(input.summary.overallMaxWindMs)} м/с, ${formatGust(input.summary.overallMaxGustMs)}.`,
    `Согласованность: ${renderAgreement(input.summary)}`,
    "",
    "Контрольные точки",
    "Диапазоны: границы ECMWF/GFS, не среднее.",
  );

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
      "",
      point.point.name,
      `Ветер ${round(point.minWindMs)}–${round(point.maxWindMs)} м/с · порывы ${gust}.`,
    );
    if (extras.length > 0) lines.push(`${capitalize(extras.join(" · "))}.`);
  }

  lines.push(
    "",
    "Обстановка",
    `Поворот ветра: ${renderDirectionTurn(input.summary)}.`,
    `Давление: ${renderPressure(input.summary)}.`,
    `Период 24–48 часов: ${renderOutlook(input.summary)}.`,
    `Прилив: ${renderTide(input.tides, generatedAt, input.timeZone)}`,
    "",
    "Выпуск",
    `Изменение: ${renderPreviousDifference(input.summary, input.previousSummary)}.`,
  );
  if (input.nextScheduledAt) {
    lines.push(`Следующий выпуск: ${formatDateTime(input.nextScheduledAt, input.timeZone)}.`);
  }
  lines.push(
    "",
    "Источники",
    "Погода: Open-Meteo (ECMWF, NOAA GFS).",
    "Приливы: Stormglass.",
  );
  return lines.join("\n");
}

function renderDirectionTurn(summary: BulletinSummary): string {
  const turns = summary.pointSummaries.flatMap((point) =>
    Object.values(point.models).flatMap((model) => {
      if (!model || model.directionStartDeg === null || model.directionEndDeg === null) return [];
      return [{
        point: point.point.name,
        model: model.model,
        start: model.directionStartDeg,
        end: model.directionEndDeg,
        angle: circularDifference(model.directionStartDeg, model.directionEndDeg),
      }];
    }),
  ).filter((turn) => turn.angle >= summary.directionChangeThresholdDeg)
    .sort((left, right) => right.angle - left.angle);
  const turn = turns[0];
  if (!turn) return "заметный поворот не выделяется";
  return `${turn.point}, ${modelLabel(turn.model)}: ${windDirectionLabel(turn.start)} → ${windDirectionLabel(turn.end)}`;
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
    const windiest = summary.pointSummaries.flatMap((point) =>
      Object.values(point.models).flatMap((model) => model ? [{ point: point.point, model }] : []))
      .sort((left, right) => right.model.maxWindMs - left.model.maxWindMs)[0];
    if (!windiest) return "Данных для выделения главного изменения недостаточно.";
    return `${modelLabel(windiest.model.model)}: наибольший ветер ожидается у точки «${windiest.point.name}» — до ${round(windiest.model.maxWindMs)} м/с.`;
  }
  const action = strongest.model.windChangeMs > 0 ? "усиление" : "ослабление";
  return `${modelLabel(strongest.model.model)}: ${action} ветра у точки «${strongest.point}» около ${formatTime(strongest.model.windChangeAt, timeZone)}.`;
}

function renderAgreement(summary: BulletinSummary): string {
  const agreement = summary.agreement;
  if (agreement.reasons.includes("одна из моделей недоступна")) {
    return "сравнение неполное — одна из моделей недоступна.";
  }
  if (agreement.agreed) return "модели в целом согласны.";
  const labels = agreement.reasons.map((reason) => AGREEMENT_LABELS[reason] ?? reason);
  return `существенные расхождения — ${labels.join(", ")}.`;
}

function renderPressure(summary: BulletinSummary): string {
  const changes = summary.pointSummaries.flatMap((point) =>
    Object.values(point.models).flatMap((model) =>
      model?.pressureChangeHpa === null || model?.pressureChangeHpa === undefined
        ? []
        : [{ point: point.point.name, model: model.model, value: model.pressureChangeHpa }]),
  );
  if (changes.length === 0) return "нет данных";
  const strongest = changes.reduce((left, right) =>
    Math.abs(left.value) >= Math.abs(right.value) ? left : right);
  if (Math.abs(strongest.value) < 1) return "без существенного изменения";
  return `${strongest.point}, ${modelLabel(strongest.model)}: ${strongest.value > 0 ? "рост" : "снижение"} на ${formatNumber(Math.abs(strongest.value))} гПа за 24 часа`;
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

function formatGust(value: number | null): string {
  return value === null ? "порывы не определены" : `порывы до ${round(value)} м/с`;
}

function modelLabel(model: WeatherModel): string {
  return model === "ecmwf" ? "ECMWF" : "GFS";
}

function capitalize(value: string): string {
  return value ? value[0]?.toLocaleUpperCase("ru-RU") + value.slice(1) : value;
}
