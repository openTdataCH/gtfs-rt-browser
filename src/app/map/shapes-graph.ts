import type { Geometry } from 'geojson';

export interface ShapesGraphMappings {
  readonly shapeIdsByTripId: ReadonlyMap<string, number>;
  readonly edgeIdsByShapeId: ReadonlyMap<number, readonly number[]>;
}

export function parseShapesGraphMappings(
  value: unknown,
  tripIds: ReadonlySet<string>
): ShapesGraphMappings {
  if (!isRecord(value) || !isRecord(value['trip_shapes']) || !isRecord(value['shapes_edges'])) {
    throw new Error('Shapes graph mappings must contain trip_shapes and shapes_edges objects.');
  }
  const tripShapes = value['trip_shapes'];
  const shapesEdges = value['shapes_edges'];
  const shapeIdsByTripId = new Map<string, number>();
  const neededShapeIds = new Set<number>();
  for (const tripId of tripIds) {
    if (!Object.hasOwn(tripShapes, tripId)) continue;
    const shapeId = tripShapes[tripId];
    if (typeof shapeId !== 'number' || !Number.isSafeInteger(shapeId) || shapeId < 1) {
      throw new Error('Invalid trip-to-shape mapping.');
    }
    shapeIdsByTripId.set(tripId, shapeId);
    neededShapeIds.add(shapeId);
  }
  const edgeIdsByShapeId = new Map<number, readonly number[]>();
  for (const shapeId of neededShapeIds) {
    if (!Object.hasOwn(shapesEdges, shapeId)) continue;
    const edgeIds = shapesEdges[String(shapeId)];
    if (!Array.isArray(edgeIds)
      || !edgeIds.every((edgeId: unknown) => typeof edgeId === 'number' && Number.isSafeInteger(edgeId) && edgeId !== 0)) {
      throw new Error('Invalid shape-to-edges mapping.');
    }
    edgeIdsByShapeId.set(shapeId, edgeIds.map((edgeId: number) => Math.abs(edgeId)));
  }
  return { shapeIdsByTripId, edgeIdsByShapeId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resultShapeEdgeIds(tripIds: Iterable<string>, mappings?: ShapesGraphMappings): number[] {
  if (!mappings) return [];
  const shapeIds = new Set<number>();
  for (const tripId of tripIds) {
    const shapeId = mappings.shapeIdsByTripId.get(tripId);
    if (shapeId !== undefined) shapeIds.add(shapeId);
  }
  const edgeIds = new Set<number>();
  for (const shapeId of shapeIds) {
    for (const edgeId of mappings.edgeIdsByShapeId.get(shapeId) ?? []) edgeIds.add(edgeId);
  }
  return [...edgeIds];
}

export function agencyShapeEdgeIds(
  trips: Iterable<{ readonly trip_id: string; readonly route_rowid: number }>,
  routes: Iterable<{ readonly rowid: number; readonly agency_id: string }>,
  mappings: ShapesGraphMappings
): ReadonlyMap<string, readonly number[]> {
  const agencyByRoute = new Map([...routes].map(route => [route.rowid, route.agency_id]));
  const shapeIdsByAgency = new Map<string, Set<number>>();
  for (const trip of trips) {
    const agencyId = agencyByRoute.get(trip.route_rowid);
    if (agencyId === undefined) continue;
    let shapeIds = shapeIdsByAgency.get(agencyId);
    if (!shapeIds) {
      shapeIds = new Set();
      shapeIdsByAgency.set(agencyId, shapeIds);
    }
    const shapeId = mappings.shapeIdsByTripId.get(trip.trip_id);
    if (shapeId !== undefined) shapeIds.add(shapeId);
  }
  const edgesByAgency = new Map<string, readonly number[]>();
  for (const [agencyId, shapeIds] of shapeIdsByAgency) {
    const edgeIds = new Set<number>();
    for (const shapeId of shapeIds) {
      for (const edgeId of mappings.edgeIdsByShapeId.get(shapeId) ?? []) edgeIds.add(edgeId);
    }
    edgesByAgency.set(agencyId, [...edgeIds]);
  }
  return edgesByAgency;
}

export function shapeEdgeBounds(
  features: Iterable<{ readonly id?: string | number; readonly geometry: Geometry }>,
  edgeIds: ReadonlySet<number>
): [[number, number], [number, number]] | undefined {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of features) {
    if (feature.id === undefined || !edgeIds.has(Number(feature.id))) continue;
    const geometry = feature.geometry;
    const lines = geometry.type === 'LineString' ? [geometry.coordinates]
      : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
    for (const line of lines) {
      for (const [longitude, latitude] of line) {
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
        west = Math.min(west, longitude);
        south = Math.min(south, latitude);
        east = Math.max(east, longitude);
        north = Math.max(north, latitude);
      }
    }
  }
  return Number.isFinite(west) ? [[west, south], [east, north]] : undefined;
}
