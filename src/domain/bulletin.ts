import type {
  BulletinSummary,
  ModelSummary,
  MarinePointSummary,
  OfficialWarning,
  TideExtreme,
  WeatherModel,
} from "./types.js";
import type { WeatherCondition } from "./weather-condition.js";
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
  marine: MarinePointSummary[];
  marineSourceUnavailable: boolean;
  weather?: WeatherCondition | null;
  timeZone: string;
}

export function renderBulletin(input: BulletinInput): string {
  const generatedAt = new Date(input.summary.generatedAt);
  const marineByPointId = new Map(input.marine.map((marine) => [marine.point.id, marine]));
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
    ...(input.weather ? [`Погодная картина: ${input.weather.icon} ${input.weather.label}.`] : []),
    `Верхняя граница моделей: ветер до ${round(input.summary.overallMaxWindMs)} м/с, ${formatGust(input.summary.overallMaxGustMs)}.`,
    `Согласованность: ${renderAgreement(input.summary)}`,
    "",
    "Контрольные точки",
    "Диапазоны: границы ECMWF/GFS, не среднее.",
  );

  for (const point of input.summary.pointSummaries) {
    const gust = point.maxGustMs === null ? "нет данных" : `до ${round(point.maxGustMs)} м/с`;
    const wind = renderPointWind(point, input.summary);
    const dynamics = renderPointWindDynamics(point, input.summary, input.timeZone);
    const turn = renderPointWindTurn(point, input.summary, input.timeZone);
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
      wind.text(point.minWindMs, point.maxWindMs, gust),
    );
    if (dynamics) {
      lines.push(`Динамика: ${dynamics.summary}.`, ...dynamics.details.map((detail) => `${detail}.`));
    }
    if (turn) lines.push(`Поворот: ${turn.summary}.`, ...turn.details.map((detail) => `${detail}.`));
    if (wind.directionUnavailable) lines.push("Направление: модели расходятся.");
    if (extras.length > 0) lines.push(`${capitalize(extras.join(" · "))}.`);
    const marine = marineByPointId.get(point.point.id);
    lines.push(marine ? `Море: ${renderMarine(marine)}.` : "Море: нет данных.");
  }

  lines.push(
    "",
    "Обстановка",
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
  lines.push(renderMarineFooter(input));
  lines.push(
    "",
    "Источники",
    "Погода: Open-Meteo (ECMWF, NOAA GFS).",
    "Волна и вода: Open-Meteo Marine.",
    "Приливы: Stormglass.",
  );
  return lines.join("\n");
}

function renderMarine(summary: MarinePointSummary): string {
  const wave = summary.minWaveHeightM === null || summary.maxWaveHeightM === null
    ? "волна: нет данных"
    : `волна ${formatNumber(summary.minWaveHeightM)}–${formatNumber(summary.maxWaveHeightM)} м${summary.waveDirectionDeg === null ? "" : `, с ${windDirectionLabel(summary.waveDirectionDeg)}`}${formatPeriod(summary.minWavePeriodSeconds, summary.maxWavePeriodSeconds)}`;
  const components: string[] = [wave];
  if (summary.maxWindWaveHeightM !== null || summary.maxSwellHeightM !== null) {
    components.push(`ветровая ${formatMetres(summary.maxWindWaveHeightM)}, зыбь ${formatMetres(summary.maxSwellHeightM)}`);
  }
  if (summary.maxCurrentKnots !== null) {
    components.push(`течение до ${formatNumber(summary.maxCurrentKnots)} уз${summary.currentDirectionDeg === null ? "" : ` на ${windDirectionLabel(summary.currentDirectionDeg)}`}`);
  }
  if (summary.seaSurfaceTemperatureC !== null) {
    components.push(`вода ${formatSigned(summary.seaSurfaceTemperatureC)} °C`);
  }
  return components.join("; ");
}

function renderMarineFooter(input: BulletinInput): string {
  if (input.marine.length > 0) {
    return "Прогноз морской модели: в губах, за островами и у берега условия могут отличаться.";
  }
  return input.marineSourceUnavailable
    ? "Морская модель временно недоступна."
    : "Данных морской модели недостаточно.";
}

function formatPeriod(minimum: number | null, maximum: number | null): string {
  if (minimum === null || maximum === null) return "";
  return `, период ${formatNumber(minimum)}–${formatNumber(maximum)} с`;
}

function formatMetres(value: number | null): string {
  return value === null ? "нет данных" : `${formatNumber(value)} м`;
}

function renderPointWind(
  point: BulletinSummary["pointSummaries"][number],
  summary: BulletinSummary,
): {
  text: (minimum: number, maximum: number, gust: string) => string;
  directionUnavailable: boolean;
} {
  const ecmwf = point.models.ecmwf;
  const gfs = point.models.gfs;
  if (!ecmwf || !gfs
    || ecmwf.directionStartDeg === null || gfs.directionStartDeg === null
    || ecmwf.directionEndDeg === null || gfs.directionEndDeg === null) {
    return {
      text: (minimum, maximum, gust) => `Ветер: ${round(minimum)}–${round(maximum)} м/с · порывы ${gust}.`,
      directionUnavailable: false,
    };
  }

  const startsAgree = circularDifference(ecmwf.directionStartDeg, gfs.directionStartDeg)
    <= summary.directionAgreementThresholdDeg;
  const endsAgree = circularDifference(ecmwf.directionEndDeg, gfs.directionEndDeg)
    <= summary.directionAgreementThresholdDeg;
  if (!startsAgree || !endsAgree) {
    return {
      text: (minimum, maximum, gust) => `Ветер: ${round(minimum)}–${round(maximum)} м/с · порывы ${gust}.`,
      directionUnavailable: true,
    };
  }

  const start = averageDirection(ecmwf.directionStartDeg, gfs.directionStartDeg);
  const direction = windDirectionLabel(start);
  return {
    text: (minimum, maximum, gust) => `Ветер: ${direction} ${round(minimum)}–${round(maximum)} м/с · порывы ${gust}.`,
    directionUnavailable: false,
  };
}

function averageDirection(left: number, right: number): number {
  const x = Math.cos(left * Math.PI / 180) + Math.cos(right * Math.PI / 180);
  const y = Math.sin(left * Math.PI / 180) + Math.sin(right * Math.PI / 180);
  return Math.atan2(y, x) * 180 / Math.PI;
}

function renderPointWindDynamics(
  point: BulletinSummary["pointSummaries"][number],
  summary: BulletinSummary,
  timeZone: string,
): { summary: string; details: string[] } | null {
  const ecmwf = point.models.ecmwf;
  const gfs = point.models.gfs;
  const ecmwfDynamics = renderModelWindDynamics(ecmwf, "ECMWF", timeZone);
  const gfsDynamics = renderModelWindDynamics(gfs, "GFS", timeZone);
  if (!ecmwfDynamics.hasChange && !gfsDynamics.hasChange) return null;

  if (ecmwfDynamics.hasChange && gfsDynamics.hasChange && ecmwf && gfs
    && ecmwf.windChangeStartedAt && gfs.windChangeStartedAt
    && ecmwf.windChangeAt && gfs.windChangeAt
    && Math.sign(ecmwf.windChangeMs) === Math.sign(gfs.windChangeMs)
    && timeRangesAgree(
      ecmwf.windChangeStartedAt,
      ecmwf.windChangeAt,
      gfs.windChangeStartedAt,
      gfs.windChangeAt,
      summary.eventTimeAgreementHours,
    )) {
    const minimum = Math.min(Math.abs(ecmwf.windChangeMs), Math.abs(gfs.windChangeMs));
    const maximum = Math.max(Math.abs(ecmwf.windChangeMs), Math.abs(gfs.windChangeMs));
    const startedAt = new Date(Math.min(ecmwf.windChangeStartedAt.getTime(), gfs.windChangeStartedAt.getTime()));
    const endedAt = new Date(Math.max(ecmwf.windChangeAt.getTime(), gfs.windChangeAt.getTime()));
    const action = ecmwf.windChangeMs > 0 ? "усиление" : "ослабление";
    return {
      summary: `${action} на ${formatRange(minimum, maximum)} м/с ${formatTimeRange(startedAt, endedAt, timeZone)}`,
      details: [],
    };
  }

  return {
    summary: ecmwf && gfs ? "модели расходятся" : "сравнение неполное",
    details: [ecmwfDynamics.text, gfsDynamics.text],
  };
}

function renderPointWindTurn(
  point: BulletinSummary["pointSummaries"][number],
  summary: BulletinSummary,
  timeZone: string,
): { summary: string; details: string[] } | null {
  const ecmwf = point.models.ecmwf;
  const gfs = point.models.gfs;
  const ecmwfTurn = renderModelWindTurn(ecmwf, "ECMWF", timeZone);
  const gfsTurn = renderModelWindTurn(gfs, "GFS", timeZone);
  if (!ecmwfTurn.hasTurn && !gfsTurn.hasTurn) return null;

  if (ecmwfTurn.hasTurn && gfsTurn.hasTurn && ecmwf && gfs
    && ecmwf.directionChangeStartDeg !== null && gfs.directionChangeStartDeg !== null
    && ecmwf.directionChangeEndDeg !== null && gfs.directionChangeEndDeg !== null
    && ecmwf.directionChangeStartedAt && gfs.directionChangeStartedAt
    && ecmwf.directionChangeAt && gfs.directionChangeAt
    && circularDifference(ecmwf.directionChangeStartDeg, gfs.directionChangeStartDeg)
      <= summary.directionAgreementThresholdDeg
    && circularDifference(ecmwf.directionChangeEndDeg, gfs.directionChangeEndDeg)
      <= summary.directionAgreementThresholdDeg
    && timeRangesAgree(
      ecmwf.directionChangeStartedAt,
      ecmwf.directionChangeAt,
      gfs.directionChangeStartedAt,
      gfs.directionChangeAt,
      summary.eventTimeAgreementHours,
    )) {
    const startDirection = averageDirection(ecmwf.directionChangeStartDeg, gfs.directionChangeStartDeg);
    const endDirection = averageDirection(ecmwf.directionChangeEndDeg, gfs.directionChangeEndDeg);
    const startedAt = new Date(Math.min(
      ecmwf.directionChangeStartedAt.getTime(),
      gfs.directionChangeStartedAt.getTime(),
    ));
    const endedAt = new Date(Math.max(ecmwf.directionChangeAt.getTime(), gfs.directionChangeAt.getTime()));
    return {
      summary: `${windDirectionLabel(startDirection)} → ${windDirectionLabel(endDirection)} ${formatTimeRange(startedAt, endedAt, timeZone)}`,
      details: [],
    };
  }

  return {
    summary: ecmwf && gfs ? "модели расходятся" : "сравнение неполное",
    details: [ecmwfTurn.text, gfsTurn.text],
  };
}

function renderModelWindTurn(
  model: ModelSummary | undefined,
  label: string,
  timeZone: string,
): { hasTurn: boolean; text: string } {
  if (!model) return { hasTurn: false, text: `${label}: нет данных` };
  if (model.directionChangeStartDeg === null || model.directionChangeEndDeg === null
    || !model.directionChangeStartedAt || !model.directionChangeAt) {
    return { hasTurn: false, text: `${label}: без заметного поворота` };
  }
  return {
    hasTurn: true,
    text: `${label}: ${windDirectionLabel(model.directionChangeStartDeg)} → ${windDirectionLabel(model.directionChangeEndDeg)} ${formatTimeRange(model.directionChangeStartedAt, model.directionChangeAt, timeZone)}`,
  };
}

function renderModelWindDynamics(
  model: ModelSummary | undefined,
  label: string,
  timeZone: string,
): { hasChange: boolean; text: string } {
  if (!model) return { hasChange: false, text: `${label}: нет данных` };
  if (model.windChangeMs === 0 || !model.windChangeAt) {
    return { hasChange: false, text: `${label}: без заметного изменения` };
  }
  const action = model.windChangeMs > 0 ? "усиление" : "ослабление";
  const timing = model.windChangeStartedAt
    ? formatTimeRange(model.windChangeStartedAt, model.windChangeAt, timeZone)
    : `около ${formatTime(model.windChangeAt, timeZone)}`;
  return {
    hasChange: true,
    text: `${label}: ${action} на ${formatNumber(Math.abs(model.windChangeMs))} м/с ${timing}`,
  };
}

function timeRangesAgree(
  leftStartedAt: Date,
  leftAt: Date,
  rightStartedAt: Date,
  rightAt: Date,
  thresholdHours: number,
): boolean {
  const endDifferenceHours = Math.abs(leftAt.getTime() - rightAt.getTime())
    / 3_600_000;
  const startDifferenceHours = Math.abs(leftStartedAt.getTime() - rightStartedAt.getTime()) / 3_600_000;
  return endDifferenceHours <= thresholdHours && startDifferenceHours <= thresholdHours;
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
  const timing = strongest.model.windChangeStartedAt
    ? formatTimeRange(strongest.model.windChangeStartedAt, strongest.model.windChangeAt, timeZone)
    : `около ${formatTime(strongest.model.windChangeAt, timeZone)}`;
  return `${modelLabel(strongest.model.model)}: ${action} ветра у точки «${strongest.point}» ${timing}.`;
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
  return model.directionChangeStartDeg !== null
    && model.directionChangeEndDeg !== null
    && circularDifference(model.directionChangeStartDeg, model.directionChangeEndDeg) >= threshold;
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

function formatRange(minimum: number, maximum: number): string {
  const formattedMinimum = formatNumber(minimum);
  const formattedMaximum = formatNumber(maximum);
  return formattedMinimum === formattedMaximum ? formattedMinimum : `${formattedMinimum}–${formattedMaximum}`;
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
