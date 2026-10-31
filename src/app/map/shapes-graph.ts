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
