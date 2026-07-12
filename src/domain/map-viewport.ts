export type BoundingBox = [west: number, south: number, east: number, north: number];

export interface MapViewport {
  bbox: BoundingBox;
  width: number;
  height: number;
}

export type MapViewportAction = "up" | "down" | "left" | "right" | "zoom-in" | "zoom-out" | "refresh";

const KILOMETRES_PER_LATITUDE_DEGREE = 111.32;
const PAN_DISTANCE_KM = 30;
const ZOOM_IN_FACTOR = 0.8;
const ZOOM_OUT_FACTOR = 1.25;
const MIN_LATITUDE_SPAN = 0.2;
const MAX_LATITUDE_SPAN = 12;
const MAX_LATITUDE = 84;

export function createMapViewport(
  bbox: BoundingBox,
  width: number,
  height: number,
): MapViewport {
  assertBoundingBox(bbox);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("Map viewport dimensions must be positive integers");
  }
  return { bbox: [...bbox] as BoundingBox, width, height };
}

export function changeMapViewport(
  viewport: MapViewport,
  action: Exclude<MapViewportAction, "refresh">,
): MapViewport {
  if (action === "zoom-in") return zoom(viewport, ZOOM_IN_FACTOR);
  if (action === "zoom-out") return zoom(viewport, ZOOM_OUT_FACTOR);
  return pan(viewport, action);
}

export function formatMapExtent(viewport: MapViewport): string {
  const [west, south, east, north] = viewport.bbox;
  const latitude = (south + north) / 2 * Math.PI / 180;
  const widthKm = (east - west) * KILOMETRES_PER_LATITUDE_DEGREE * Math.cos(latitude);
  const heightKm = (north - south) * KILOMETRES_PER_LATITUDE_DEGREE;
  return `Охват: примерно ${Math.round(widthKm)} × ${Math.round(heightKm)} км`;
}

function pan(viewport: MapViewport, action: "up" | "down" | "left" | "right"): MapViewport {
  const [west, south, east, north] = viewport.bbox;
  const centerLatitude = (south + north) / 2;
  const latitudeDelta = PAN_DISTANCE_KM / KILOMETRES_PER_LATITUDE_DEGREE;
  const longitudeDelta = PAN_DISTANCE_KM / (
    KILOMETRES_PER_LATITUDE_DEGREE * Math.max(0.1, Math.cos(centerLatitude * Math.PI / 180))
  );
  const latitudeShift = action === "up" ? latitudeDelta : action === "down" ? -latitudeDelta : 0;
  const longitudeShift = action === "right" ? longitudeDelta : action === "left" ? -longitudeDelta : 0;
  return viewportWithCenter(
    viewport,
    (west + east) / 2 + longitudeShift,
    centerLatitude + latitudeShift,
  );
}

function zoom(viewport: MapViewport, factor: number): MapViewport {
  const [west, south, east, north] = viewport.bbox;
  const centerLongitude = (west + east) / 2;
  const centerLatitude = (south + north) / 2;
  const currentLatitudeSpan = north - south;
  const latitudeSpan = Math.min(MAX_LATITUDE_SPAN, Math.max(MIN_LATITUDE_SPAN, currentLatitudeSpan * factor));
  const longitudeSpan = (east - west) * latitudeSpan / currentLatitudeSpan;
  return viewportWithCenter(viewport, centerLongitude, centerLatitude, latitudeSpan, longitudeSpan);
}

function viewportWithCenter(
  viewport: MapViewport,
  longitude: number,
  latitude: number,
  latitudeSpan = viewport.bbox[3] - viewport.bbox[1],
  longitudeSpan = viewport.bbox[2] - viewport.bbox[0],
): MapViewport {
  const boundedLatitude = Math.min(
    MAX_LATITUDE - latitudeSpan / 2,
    Math.max(-MAX_LATITUDE + latitudeSpan / 2, latitude),
  );
  const boundedLongitude = Math.min(
    180 - longitudeSpan / 2,
    Math.max(-180 + longitudeSpan / 2, longitude),
  );
  return createMapViewport([
    boundedLongitude - longitudeSpan / 2,
    boundedLatitude - latitudeSpan / 2,
    boundedLongitude + longitudeSpan / 2,
    boundedLatitude + latitudeSpan / 2,
  ], viewport.width, viewport.height);
}

function assertBoundingBox([west, south, east, north]: BoundingBox): void {
  if (![west, south, east, north].every(Number.isFinite)
    || west >= east || south >= north
    || west < -180 || east > 180 || south < -MAX_LATITUDE || north > MAX_LATITUDE) {
    throw new Error("Map viewport has invalid bounding box");
  }
}
