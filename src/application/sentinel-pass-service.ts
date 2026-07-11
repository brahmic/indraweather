import * as SunCalc from "suncalc";
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from "satellite.js";
import type { EumetsatTleClient, TleRecord } from "../infrastructure/eumetsat-tle.js";
import type { SentinelPlatform } from "../infrastructure/eumetsat-catalog.js";

export interface SentinelPassOptions {
  latitude: number;
  longitude: number;
  maxGroundTrackDistanceKm: number;
  predictionHours?: number;
  stepSeconds?: number;
}

interface OrbitModel {
  satrec: SatRec;
  epochMs: number;
}

export class SentinelPassService {
  constructor(
    private readonly tleClient: EumetsatTleClient,
    private readonly options: SentinelPassOptions,
  ) {}

  async nextPass(now = new Date()): Promise<Date | null> {
    try {
      return predictNextPass(await this.tleClient.getRecords(now), now, this.options);
    } catch {
      return null;
    }
  }
}

export function predictNextPass(
  records: TleRecord[],
  now: Date,
  options: SentinelPassOptions,
): Date | null {
  const models = groupModels(records);
  const stepMs = (options.stepSeconds ?? 60) * 1000;
  const startMs = now.getTime() + 10 * 60_000;
  const endMs = now.getTime() + (options.predictionHours ?? 48) * 3_600_000;
  const passes: Date[] = [];

  for (const platform of ["Sentinel-3A", "Sentinel-3B"] as const) {
    const platformModels = models.get(platform) ?? [];
    let closest: { date: Date; distanceKm: number } | null = null;
    for (let timestamp = startMs; timestamp <= endMs; timestamp += stepMs) {
      const date = new Date(timestamp);
      const model = nearestModel(platformModels, timestamp);
      const distanceKm = model ? groundTrackDistance(model.satrec, date, options) : null;
      const daylight = SunCalc.getPosition(date, options.latitude, options.longitude).altitude > 0;
      if (distanceKm !== null && distanceKm <= options.maxGroundTrackDistanceKm && daylight) {
        if (!closest || distanceKm < closest.distanceKm) closest = { date, distanceKm };
      } else if (closest) {
        break;
      }
    }
    if (closest) passes.push(closest.date);
  }
  return passes.sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
}

function groupModels(records: TleRecord[]): Map<SentinelPlatform, OrbitModel[]> {
  const result = new Map<SentinelPlatform, OrbitModel[]>();
  for (const record of records) {
    const satrec = twoline2satrec(record.line1, record.line2);
    const model = { satrec, epochMs: (satrec.jdsatepoch - 2_440_587.5) * 86_400_000 };
    result.set(record.platform, [...(result.get(record.platform) ?? []), model]);
  }
  return result;
}

function nearestModel(models: OrbitModel[], timestamp: number): OrbitModel | null {
  return models.reduce<OrbitModel | null>((best, current) => {
    if (!best) return current;
    return Math.abs(current.epochMs - timestamp) < Math.abs(best.epochMs - timestamp)
      ? current
      : best;
  }, null);
}

function groundTrackDistance(
  satrec: SatRec,
  date: Date,
  target: Pick<SentinelPassOptions, "latitude" | "longitude">,
): number | null {
  const state = propagate(satrec, date);
  if (!state) return null;
  const position = eciToGeodetic(state.position, gstime(date));
  return haversineKm(
    target.latitude,
    target.longitude,
    degreesLat(position.latitude),
    degreesLong(position.longitude),
  );
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(lat2 - lat1);
  const longitudeDelta = radians(lon2 - lon1);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
