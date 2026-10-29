import type { FeatureCollection, LineString } from 'geojson';

export function parseTripShape(value: unknown): FeatureCollection<LineString> {
  if (!isRecord(value) || value['type'] !== 'Feature') throw new Error('Invalid shape feature');
  const geometry = value['geometry'];
  if (!isRecord(geometry) || geometry['type'] !== 'LineString') throw new Error('Invalid shape geometry');
  const coordinates = geometry['coordinates'];
  if (!Array.isArray(coordinates) || coordinates.length < 2
    || !coordinates.every(point => Array.isArray(point) && point.length >= 2
      && typeof point[0] === 'number' && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
      && typeof point[1] === 'number' && Number.isFinite(point[1]) && Math.abs(point[1]) <= 85)) {
    throw new Error('Invalid shape coordinates');
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
