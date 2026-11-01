import type { Position } from 'geojson';
import type { MapStop } from './map-stop.model';

export interface TripPositionUpdate {
  readonly tripId: string | undefined;
  readonly minute: number | undefined;
  readonly coordinates: Position | undefined;
}

export function validPosition(point: unknown): point is Position {
  return Array.isArray(point) && point.length >= 2
    && typeof point[0] === 'number' && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
    && typeof point[1] === 'number' && Number.isFinite(point[1]) && Math.abs(point[1]) <= 85;
}

export function parseTripPolyline(value: unknown): Position[] {
  if (!value || typeof value !== 'object' || !('geometry' in value)) throw new Error('Invalid trip shape');
  const geometry = value.geometry;
  if (!geometry || typeof geometry !== 'object' || !('type' in geometry) || geometry.type !== 'LineString'
    || !('coordinates' in geometry) || !Array.isArray(geometry.coordinates)
    || geometry.coordinates.length < 2 || !geometry.coordinates.every(validPosition)) {
    throw new Error('Invalid trip shape coordinates');
  }
  return geometry.coordinates;
}

/** Estimate from effective stop times, holding at stops during dwell periods. */
export function estimateTripPosition(
  stops: readonly MapStop[], now: number | undefined, polyline?: readonly Position[]
): Position | undefined {
  if (now === undefined || !Number.isFinite(now)) return;
  const timed = stops.filter(stop => !stop.isSkipped
    && (Number.isFinite(stop.arrivalMinute) || Number.isFinite(stop.departureMinute)));
  if (!timed.length) return;
  const first = timed[0];
  const last = timed[timed.length - 1];
  const start = first.departureMinute ?? first.arrivalMinute!;
  const end = last.arrivalMinute ?? last.departureMinute!;
  if (now < start || now > end) return;

  const path = polyline && polyline.length >= 2 ? polyline : undefined;
  const distances = path ? cumulativeDistances(path) : [];
  let minimum = 0;
  const anchors = timed.map(stop => {
    const point = [stop.longitude, stop.latitude];
    if (!path || !validPosition(point)) return undefined;
    const anchor = projectToPath(point, path, distances, minimum);
    if (anchor !== undefined) minimum = anchor;
    return anchor;
  });

  for (let index = 0; index < timed.length; index++) {
    const stop = timed[index];
    const arrival = stop.arrivalMinute ?? stop.departureMinute!;
    const departure = stop.departureMinute ?? stop.arrivalMinute!;
    const point = [stop.longitude, stop.latitude];
    if (now >= arrival && now <= departure) {
      if (!validPosition(point)) return;
      const anchor = anchors[index];
      return path && anchor !== undefined ? pointAlongPath(path, distances, anchor) : point;
    }
    const next = timed[index + 1];
    if (!next) continue;
    const nextArrival = next.arrivalMinute ?? next.departureMinute!;
    if (now <= departure || now >= nextArrival || nextArrival <= departure) continue;
    const nextPoint = [next.longitude, next.latitude];
    if (!validPosition(point) || !validPosition(nextPoint)) return;
    const fraction = (now - departure) / (nextArrival - departure);
    const from = anchors[index];
    const to = anchors[index + 1];
    if (path && from !== undefined && to !== undefined && to > from) {
      return pointAlongPath(path, distances, from + fraction * (to - from));
    }
    return interpolate(point, nextPoint, fraction);
  }
  return undefined;
}

function interpolate(from: Position, to: Position, fraction: number): Position {
  return [from[0] + fraction * (to[0] - from[0]), from[1] + fraction * (to[1] - from[1])];
}

function distance(from: Position, to: Position): number {
  const x = (to[0] - from[0]) * Math.cos((from[1] + to[1]) * Math.PI / 360);
  return Math.hypot(x, to[1] - from[1]) * 111_195;
}

function cumulativeDistances(path: readonly Position[]): number[] {
  const distances = [0];
  for (let index = 1; index < path.length; index++) {
    distances.push(distances[index - 1] + distance(path[index - 1], path[index]));
  }
  return distances;
}

function projectToPath(point: Position, path: readonly Position[], distances: readonly number[], minimum: number): number | undefined {
  let nearest = Infinity;
  let result: number | undefined;
  const scale = Math.cos(point[1] * Math.PI / 180);
  for (let index = 1; index < path.length; index++) {
    const length = distances[index] - distances[index - 1];
    if (length === 0 || distances[index] < minimum) continue;
    const from = path[index - 1];
    const to = path[index];
    const dx = (to[0] - from[0]) * scale;
    const dy = to[1] - from[1];
    const fraction = Math.max(0, (minimum - distances[index - 1]) / length,
      Math.min(1, (((point[0] - from[0]) * scale * dx) + (point[1] - from[1]) * dy) / (dx * dx + dy * dy)));
    const separation = distance(point, interpolate(from, to, fraction));
    if (separation < nearest) {
      nearest = separation;
      result = distances[index - 1] + fraction * length;
    }
  }
  // A stop far from the returned shape cannot be positioned reliably on it.
  return nearest <= 1_000 ? result : undefined;
}

function pointAlongPath(path: readonly Position[], distances: readonly number[], at: number): Position {
  for (let index = 1; index < path.length; index++) {
    const length = distances[index] - distances[index - 1];
    if (length > 0 && at <= distances[index]) {
      return interpolate(path[index - 1], path[index], Math.max(0, (at - distances[index - 1]) / length));
    }
  }
  return [...path[path.length - 1]];
}
