export const WEATHER_MODELS = ["ecmwf", "gfs"] as const;
export type WeatherModel = (typeof WEATHER_MODELS)[number];

export interface ControlPoint {
  id: string;
  name: string;
  shortName: string;
  latitude: number;
  longitude: number;
  order: number;
  active: boolean;
}

export interface ForecastValue {
  pointId: string;
  model: WeatherModel;
  forecastAt: Date;
  receivedAt: Date;
  windSpeedMs: number | null;
  windGustMs: number | null;
  windDirectionDeg: number | null;
  precipitationMm: number | null;
  precipitationProbabilityPct: number | null;
  weatherCode: number | null;
  visibilityKm: number | null;
  pressureHpa: number | null;
  temperatureC: number | null;
}

export interface TideExtreme {
  extremeAt: Date;
  type: "high" | "low";
  heightM: number | null;
  source: string;
  stationName: string | null;
}

export interface OfficialWarning {
  fingerprint: string;
  source: string;
  sourceUrl: string;
  rawText: string;
  publishedAt: Date | null;
}

export interface MarinePointSummary {
  point: ControlPoint;
  minWaveHeightM: number | null;
  maxWaveHeightM: number | null;
  waveDirectionDeg: number | null;
  minWavePeriodSeconds: number | null;
  maxWavePeriodSeconds: number | null;
  maxWindWaveHeightM: number | null;
  maxSwellHeightM: number | null;
  maxCurrentKnots: number | null;
  currentDirectionDeg: number | null;
  seaSurfaceTemperatureC: number | null;
}

export interface MarineForecastValue {
  pointId: string;
  forecastAt: Date;
  waveHeightM: number | null;
  waveDirectionDeg: number | null;
  wavePeriodSeconds: number | null;
  windWaveHeightM: number | null;
  swellHeightM: number | null;
  currentSpeedKmh: number | null;
  currentDirectionDeg: number | null;
  seaSurfaceTemperatureC: number | null;
}

export interface ModelSummary {
  model: WeatherModel;
  minWindMs: number;
  maxWindMs: number;
  maxGustMs: number | null;
  directionStartDeg: number | null;
  directionEndDeg: number | null;
  windChangeMs: number;
  windChangeAt: Date | null;
  precipitationMm: number;
  minVisibilityKm: number | null;
  pressureChangeHpa: number | null;
  minTemperatureC: number | null;
  maxTemperatureC: number | null;
}

export interface PointSummary {
  point: ControlPoint;
  models: Partial<Record<WeatherModel, ModelSummary>>;
  minWindMs: number;
  maxWindMs: number;
  maxGustMs: number | null;
  precipitationMm: number;
  minVisibilityKm: number | null;
}

export interface ModelAgreement {
  agreed: boolean;
  windDifferenceMs: number | null;
  gustDifferenceMs: number | null;
  directionDifferenceDeg: number | null;
  eventTimeDifferenceHours: number | null;
  reasons: string[];
}

export interface BulletinSummary {
  generatedAt: string;
  horizonHours: number;
  directionChangeThresholdDeg: number;
  pointSummaries: PointSummary[];
  agreement: ModelAgreement;
  overallMaxWindMs: number;
  overallMaxGustMs: number | null;
  outlook: {
    maxWindMs: number | null;
    maxGustMs: number | null;
  };
}
