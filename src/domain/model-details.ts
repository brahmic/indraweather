import { circularDifference } from "./analysis.js";
import { windDirectionLabel } from "./bulletin.js";
import type { BulletinSummary, ModelSummary, PointSummary, WeatherModel } from "./types.js";

const MODEL_LABELS: Record<WeatherModel, string> = {
  ecmwf: "ECMWF",
  gfs: "GFS",
};

export function renderModelDetails(summary: BulletinSummary, timeZone: string): string {
  const generatedAt = new Date(summary.generatedAt);
  const lines = [
    `Детализация по моделям · ${formatDateTime(generatedAt, timeZone)}`,
    `Период: ближайшие ${summary.horizonHours} часа. Значения моделей не усредняются.`,
  ];

  for (const point of summary.pointSummaries) {
    lines.push("", point.point.name);
    for (const model of ["ecmwf", "gfs"] as const) {
      const modelSummary = point.models[model];
      lines.push(modelSummary
        ? `${MODEL_LABELS[model]}: ${renderModel(modelSummary, timeZone)}.`
        : `${MODEL_LABELS[model]}: нет данных.`);
    }
    const difference = renderDifference(point);
    if (difference) lines.push(`Расхождение: ${difference}.`);
  }

  lines.push("", `Итог сравнения: ${renderAgreement(summary)}.`);
  lines.push("Данные: Open-Meteo (ECMWF, NOAA GFS).");
  return lines.join("\n");
}

function renderModel(model: ModelSummary, timeZone: string): string {
  const parts = [
    `ветер ${formatNumber(model.minWindMs)}–${formatNumber(model.maxWindMs)} м/с`,
    model.maxGustMs === null
      ? "порывы —"
      : `порывы до ${formatNumber(model.maxGustMs)} м/с`,
    `направление ${formatDirection(model)}`,
    `осадки ${formatNumber(model.precipitationMm)} мм`,
    model.minVisibilityKm === null
      ? "видимость —"
      : `видимость от ${formatNumber(model.minVisibilityKm)} км`,
    `давление ${formatPressure(model.pressureChangeHpa)}`,
    `температура ${formatTemperature(model)}`,
    `ощущается как ${formatSignedRange(
      model.minApparentTemperatureC,
      model.maxApparentTemperatureC,
    )}`,
    `влажность ${formatHumidity(model)}`,
    `точка росы ${formatSignedRange(model.minDewPointC, model.maxDewPointC)}`,
  ];
  if (model.nearSaturation) parts.push("в отдельные часы воздух близок к насыщению");
  if (model.windChangeAt && model.windChangeMs !== 0) {
    const action = model.windChangeMs > 0 ? "усиление" : "ослабление";
    const timing = model.windChangeStartedAt
      ? formatTimeRange(model.windChangeStartedAt, model.windChangeAt, timeZone)
      : `около ${formatTime(model.windChangeAt, timeZone)}`;
    parts.push(`${action} на ${formatNumber(Math.abs(model.windChangeMs))} м/с ${timing}`);
  }
  const turn = formatDirectionTurn(model, timeZone);
  if (turn) parts.push(`поворот ${turn}`);
  return parts.join("; ");
}

function formatDirectionTurn(model: ModelSummary, timeZone: string): string | null {
  if (model.directionChangeStartDeg === null || model.directionChangeEndDeg === null
    || !model.directionChangeStartedAt || !model.directionChangeAt) return null;
  return `${windDirectionLabel(model.directionChangeStartDeg)} → ${windDirectionLabel(model.directionChangeEndDeg)} ${formatTimeRange(model.directionChangeStartedAt, model.directionChangeAt, timeZone)}`;
}

function renderDifference(point: PointSummary): string | null {
  const ecmwf = point.models.ecmwf;
  const gfs = point.models.gfs;
  if (!ecmwf || !gfs) return null;
  const parts = [
    `максимальный ветер ${formatNumber(Math.abs(ecmwf.maxWindMs - gfs.maxWindMs))} м/с`,
  ];
  if (ecmwf.maxGustMs !== null && gfs.maxGustMs !== null) {
    parts.push(`порывы ${formatNumber(Math.abs(ecmwf.maxGustMs - gfs.maxGustMs))} м/с`);
  }
  if (ecmwf.directionEndDeg !== null && gfs.directionEndDeg !== null) {
    parts.push(`направление ${formatNumber(circularDifference(ecmwf.directionEndDeg, gfs.directionEndDeg))}°`);
  }
  return parts.join(", ");
}

function renderAgreement(summary: BulletinSummary): string {
  if (summary.agreement.reasons.includes("одна из моделей недоступна")) {
    return "сравнение неполное, одна из моделей недоступна";
  }
  return summary.agreement.agreed
    ? "модели в целом согласны"
    : summary.agreement.reasons.join(", ");
}

function formatDirection(model: ModelSummary): string {
  if (model.directionStartDeg === null || model.directionEndDeg === null) return "—";
  return `${windDirectionLabel(model.directionStartDeg)} → ${windDirectionLabel(model.directionEndDeg)}`;
}

function formatPressure(value: number | null): string {
  if (value === null) return "—";
  if (Math.abs(value) < 1) return "без существенного изменения";
  return `${value > 0 ? "рост" : "снижение"} на ${formatNumber(Math.abs(value))} гПа`;
}

function formatTemperature(model: ModelSummary): string {
  return formatSignedRange(model.minTemperatureC, model.maxTemperatureC);
}

function formatSignedRange(minimum: number | null, maximum: number | null): string {
  if (minimum === null || maximum === null) return "—";
  return `${formatSigned(minimum)}…${formatSigned(maximum)} °C`;
}

function formatHumidity(model: ModelSummary): string {
  if (model.minRelativeHumidityPct === null || model.maxRelativeHumidityPct === null) return "—";
  return `${formatNumber(model.minRelativeHumidityPct)}–${formatNumber(model.maxRelativeHumidityPct)}%`;
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

function formatTimeRange(startedAt: Date, endedAt: Date, timeZone: string): string {
  return `с ${formatClock(startedAt, timeZone)} до ${formatTime(endedAt, timeZone)}`;
}

function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}
