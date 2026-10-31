export interface ShapesGraphMappings {
  readonly shapeIdsByTripId: ReadonlyMap<string, number>;
  readonly edgeIdsByShapeId: ReadonlyMap<number, readonly number[]>;
}

export function parseShapesGraphMappings(
  tripRows: unknown,
  shapeRows: unknown,
  tripIds: ReadonlySet<string>
): ShapesGraphMappings {
  if (!Array.isArray(tripRows) || !Array.isArray(shapeRows)) {
    throw new Error('Shapes graph mappings must be arrays.');
  }
  const shapeIdsByTripId = new Map<string, number>();
  const neededShapeIds = new Set<number>();
  for (const row of tripRows) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
      || !Number.isSafeInteger(row[1]) || row[1] < 1) {
      throw new Error('Invalid trip-to-shape mapping.');
    }
    if (tripIds.has(row[0])) {
      shapeIdsByTripId.set(row[0], row[1]);
      neededShapeIds.add(row[1]);
    }
  }
  const edgeIdsByShapeId = new Map<number, readonly number[]>();
  for (const row of shapeRows) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0])
      || row[0] < 1 || !Array.isArray(row[1])
      || !row[1].every((edgeId: unknown) => typeof edgeId === 'number' && Number.isSafeInteger(edgeId) && edgeId !== 0)) {
      throw new Error('Invalid shape-to-edges mapping.');
    }
    if (neededShapeIds.has(row[0])) {
      edgeIdsByShapeId.set(row[0], row[1].map((edgeId: number) => Math.abs(edgeId)));
    }
  }
  return { shapeIdsByTripId, edgeIdsByShapeId };
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
