import type {
  BulletinSummary,
  ControlPoint,
  ForecastValue,
  ModelAgreement,
  ModelSummary,
  PointSummary,
  WeatherModel,
} from "./types.js";
import { WEATHER_MODELS } from "./types.js";

export interface AnalysisThresholds {
  windChangeMs: number;
  windAgreementMs: number;
  gustAgreementMs: number;
  directionChangeDeg: number;
  directionAgreementDeg: number;
  eventTimeAgreementHours: number;
}

export function circularDifference(left: number, right: number): number {
  const difference = Math.abs(normalizeAngle(left) - normalizeAngle(right));
  return Math.min(difference, 360 - difference);
}

export function analyzeForecast(
  points: ControlPoint[],
  values: ForecastValue[],
  generatedAt: Date,
  thresholds: AnalysisThresholds,
): BulletinSummary {
  const horizonEnd = generatedAt.getTime() + 24 * 60 * 60 * 1000;
  const outlookEnd = generatedAt.getTime() + 48 * 60 * 60 * 1000;
  const current = values.filter((value) =>
    value.forecastAt.getTime() >= generatedAt.getTime()
    && value.forecastAt.getTime() <= horizonEnd
  );

  const pointSummaries = points.flatMap((point): PointSummary[] => {
    const models: Partial<Record<WeatherModel, ModelSummary>> = {};
    for (const model of WEATHER_MODELS) {
      const series = current
        .filter((value) => value.pointId === point.id && value.model === model)
        .sort((left, right) => left.forecastAt.getTime() - right.forecastAt.getTime());
      const summary = summarizeModel(model, series, thresholds.windChangeMs);
      if (summary) models[model] = summary;
    }
    const summaries = Object.values(models);
    if (summaries.length === 0) return [];
    return [{
      point,
      models,
      minWindMs: min(summaries.map((item) => item.minWindMs)) ?? 0,
      maxWindMs: max(summaries.map((item) => item.maxWindMs)) ?? 0,
      maxGustMs: max(summaries.map((item) => item.maxGustMs)),
      precipitationMm: max(summaries.map((item) => item.precipitationMm)) ?? 0,
      minVisibilityKm: min(summaries.map((item) => item.minVisibilityKm)),
    }];
  });

  if (pointSummaries.length === 0) {
    throw new Error("No forecast values in the next 24 hours");
  }
  const outlook = values.filter((value) =>
    value.forecastAt.getTime() > horizonEnd
    && value.forecastAt.getTime() <= outlookEnd
  );

  return {
    generatedAt: generatedAt.toISOString(),
    horizonHours: 24,
    directionChangeThresholdDeg: thresholds.directionChangeDeg,
    directionAgreementThresholdDeg: thresholds.directionAgreementDeg,
    pointSummaries,
    agreement: analyzeAgreement(pointSummaries, thresholds),
    overallMaxWindMs: max(pointSummaries.map((item) => item.maxWindMs)) ?? 0,
    overallMaxGustMs: max(pointSummaries.map((item) => item.maxGustMs)),
    outlook: {
      maxWindMs: max(outlook.map((item) => item.windSpeedMs)),
      maxGustMs: max(outlook.map((item) => item.windGustMs)),
    },
  };
}

function summarizeModel(
  model: WeatherModel,
  series: ForecastValue[],
  windChangeThresholdMs: number,
): ModelSummary | null {
  const wind = series.filter(hasWind);
  if (wind.length === 0) return null;

  let strongestChange = 0;
  let windChangeAt: Date | null = null;
  for (let index = 3; index < wind.length; index += 1) {
    const previous = wind[index - 3];
    const current = wind[index];
    if (!previous || !current || previous.windSpeedMs === null || current.windSpeedMs === null) continue;
    const change = current.windSpeedMs - previous.windSpeedMs;
    if (Math.abs(change) > Math.abs(strongestChange)) {
      strongestChange = change;
      windChangeAt = current.forecastAt;
    }
  }
  if (Math.abs(strongestChange) < windChangeThresholdMs) {
    strongestChange = 0;
    windChangeAt = null;
  }

  const firstDirection = series.find((item) => item.windDirectionDeg !== null)?.windDirectionDeg ?? null;
  const lastDirection = series.findLast((item) => item.windDirectionDeg !== null)?.windDirectionDeg ?? null;
  const firstPressure = series.find((item) => item.pressureHpa !== null)?.pressureHpa ?? null;
  const lastPressure = series.findLast((item) => item.pressureHpa !== null)?.pressureHpa ?? null;

  return {
    model,
    minWindMs: min(wind.map((item) => item.windSpeedMs)) ?? 0,
    maxWindMs: max(wind.map((item) => item.windSpeedMs)) ?? 0,
    maxGustMs: max(series.map((item) => item.windGustMs)),
    directionStartDeg: firstDirection,
    directionEndDeg: lastDirection,
    windChangeMs: strongestChange,
    windChangeAt,
    precipitationMm: sum(series.map((item) => item.precipitationMm)),
    minVisibilityKm: min(series.map((item) => item.visibilityKm)),
    pressureChangeHpa: firstPressure === null || lastPressure === null
      ? null
      : lastPressure - firstPressure,
    minTemperatureC: min(series.map((item) => item.temperatureC)),
    maxTemperatureC: max(series.map((item) => item.temperatureC)),
  };
}

function analyzeAgreement(
  points: PointSummary[],
  thresholds: AnalysisThresholds,
): ModelAgreement {
  const pairs = points.flatMap((point) => {
    const ecmwf = point.models.ecmwf;
    const gfs = point.models.gfs;
    return ecmwf && gfs ? [{ ecmwf, gfs }] : [];
  });
  if (pairs.length === 0) {
    return {
      agreed: false,
      windDifferenceMs: null,
      gustDifferenceMs: null,
      directionDifferenceDeg: null,
      eventTimeDifferenceHours: null,
      reasons: ["одна из моделей недоступна"],
    };
  }

  const windDifferenceMs = max(pairs.map(({ ecmwf, gfs }) =>
    Math.abs(ecmwf.maxWindMs - gfs.maxWindMs))) ?? null;
  const gustDifferenceMs = max(pairs.map(({ ecmwf, gfs }) =>
    ecmwf.maxGustMs === null || gfs.maxGustMs === null
      ? null
      : Math.abs(ecmwf.maxGustMs - gfs.maxGustMs))) ?? null;
  const directionDifferenceDeg = max(pairs.map(({ ecmwf, gfs }) =>
    ecmwf.directionEndDeg === null || gfs.directionEndDeg === null
      ? null
      : circularDifference(ecmwf.directionEndDeg, gfs.directionEndDeg))) ?? null;
  const eventTimeDifferenceHours = max(pairs.map(({ ecmwf, gfs }) =>
    ecmwf.windChangeAt === null || gfs.windChangeAt === null
      ? null
      : Math.abs(ecmwf.windChangeAt.getTime() - gfs.windChangeAt.getTime()) / 3_600_000)) ?? null;
  const eventPresenceMismatch = pairs.some(({ ecmwf, gfs }) =>
    (ecmwf.windChangeAt === null) !== (gfs.windChangeAt === null));

  const reasons: string[] = [];
  if (windDifferenceMs !== null && windDifferenceMs > thresholds.windAgreementMs) {
    reasons.push("расходятся по силе ветра");
  }
  if (gustDifferenceMs !== null && gustDifferenceMs > thresholds.gustAgreementMs) {
    reasons.push("расходятся по порывам");
  }
  if (directionDifferenceDeg !== null && directionDifferenceDeg > thresholds.directionAgreementDeg) {
    reasons.push("расходятся по направлению");
  }
  if (eventPresenceMismatch) {
    reasons.push("расходятся по наличию заметного изменения ветра");
  }
  if (eventTimeDifferenceHours !== null && eventTimeDifferenceHours > thresholds.eventTimeAgreementHours) {
    reasons.push("расходятся по времени изменения");
  }

  return {
    agreed: reasons.length === 0,
    windDifferenceMs,
    gustDifferenceMs,
    directionDifferenceDeg,
    eventTimeDifferenceHours,
    reasons,
  };
}

function hasWind(value: ForecastValue): boolean {
  return value.windSpeedMs !== null;
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 360) % 360;
}

function min(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length === 0 ? null : Math.min(...valid);
}

function max(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length === 0 ? null : Math.max(...valid);
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
