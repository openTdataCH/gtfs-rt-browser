/// <reference lib="webworker" />

import GtfsRealtimeBindings, { transit_realtime } from 'gtfs-realtime-bindings';
import {
  FeedMetadataDto, StopScheduleRelationship, StopTimeEventDto,
  StopTimeUpdateDto, TripScheduleRelationship, TripUpdateDto
} from '../dto';

interface ParseRequest { type: 'parse'; url: string; }
const CHUNK_SIZE = 250;

addEventListener('message', ({ data }: MessageEvent<ParseRequest>) => {
  if (data.type === 'parse') void parseFeed(data.url);
});

async function parseFeed(url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Feed request failed: ${response.status} ${response.statusText}`);
    const feed = await decodeFeed(response);
    const tripEntities = feed.entity.filter((entity) => entity.tripUpdate && !entity.isDeleted);

    const metadata: FeedMetadataDto = {
      version: feed.header.gtfsRealtimeVersion,
      incrementality: ['FULL_DATASET', 'DIFFERENTIAL'][feed.header.incrementality] as FeedMetadataDto['incrementality'] ?? 'UNKNOWN',
      timestamp: present(feed.header, 'timestamp') ? toNumber(feed.header.timestamp) : undefined,
      entityCount: feed.entity.length,
      tripUpdateCount: tripEntities.length
    };
    postMessage({ type: 'metadata', metadata });

    for (let index = 0; index < tripEntities.length; index += CHUNK_SIZE) {
      const updates = tripEntities.slice(index, index + CHUNK_SIZE).map(toTripUpdateDto);
      postMessage({ type: 'trip-updates', updates, processed: Math.min(index + CHUNK_SIZE, tripEntities.length) });
      await new Promise<void>((resolve) => setTimeout(resolve));
    }
    postMessage({ type: 'complete', count: tripEntities.length });
  } catch (error: unknown) {
    postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unknown GTFS-RT parsing error.' });
  }
}

async function decodeFeed(response: Response): Promise<transit_realtime.FeedMessage> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
  const isJsonMime = contentType.includes('application/json') || contentType.includes('+json');
  const isJsonBody = firstNonWhitespaceByte(bytes) === 0x7b || firstNonWhitespaceByte(bytes) === 0x5b;

  if (!isJsonMime && !isJsonBody) {
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`GTFS-RT response is JSON but could not be parsed: ${reason}`);
  }

  if (!isRecord(json)) {
    throw new Error('GTFS-RT JSON response must contain a FeedMessage object.');
  }

  const validationError = GtfsRealtimeBindings.transit_realtime.FeedMessage.verify(json);
  if (validationError) {
    // fromObject also accepts protobuf JSON enum names and 64-bit integer strings,
    // which verify() intentionally rejects because it expects wire-shaped values.
    try {
      return GtfsRealtimeBindings.transit_realtime.FeedMessage.fromObject(json);
    } catch {
      throw new Error(`Invalid GTFS-RT JSON FeedMessage: ${validationError}`);
    }
  }

  return GtfsRealtimeBindings.transit_realtime.FeedMessage.fromObject(json);
}

function firstNonWhitespaceByte(bytes: Uint8Array): number | undefined {
  for (const byte of bytes) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTripUpdateDto(entity: transit_realtime.FeedEntity): TripUpdateDto {
  const update = entity.tripUpdate!;
  const trip = update.trip;
  return {
    entityId: entity.id,
    trip: {
      tripId: value(trip.tripId), routeId: value(trip.routeId),
      directionId: present(trip, 'directionId') ? trip.directionId : undefined,
      startTime: value(trip.startTime), startDate: value(trip.startDate),
      scheduleRelationship: tripRelationship(trip.scheduleRelationship)
    },
    vehicle: update.vehicle ? {
      id: value(update.vehicle.id), label: value(update.vehicle.label),
      licensePlate: value(update.vehicle.licensePlate)
    } : undefined,
    stopTimeUpdates: update.stopTimeUpdate.map(toStopTimeUpdateDto),
    timestamp: present(update, 'timestamp') ? toNumber(update.timestamp) : undefined,
    delay: present(update, 'delay') ? update.delay : undefined
  };
}

function toStopTimeUpdateDto(stop: transit_realtime.TripUpdate.StopTimeUpdate): StopTimeUpdateDto {
  return {
    stopSequence: present(stop, 'stopSequence') ? stop.stopSequence : undefined,
    stopId: value(stop.stopId), arrival: stop.arrival ? toEvent(stop.arrival) : undefined,
    departure: stop.departure ? toEvent(stop.departure) : undefined,
    scheduleRelationship: stopRelationship(stop.scheduleRelationship),
    assignedStopId: value(stop.stopTimeProperties?.assignedStopId)
  };
}

function toEvent(event: transit_realtime.TripUpdate.StopTimeEvent): StopTimeEventDto {
  return {
    delay: present(event, 'delay') ? event.delay : undefined,
    time: present(event, 'time') ? toNumber(event.time) : undefined,
    uncertainty: present(event, 'uncertainty') ? event.uncertainty : undefined
  };
}

function tripRelationship(value: number): TripScheduleRelationship {
  return (['SCHEDULED', 'ADDED', 'UNSCHEDULED', 'CANCELED', 'UNKNOWN', 'REPLACEMENT', 'DUPLICATED'][value]
    ?? 'UNKNOWN') as TripScheduleRelationship;
}

function stopRelationship(value: number): StopScheduleRelationship {
  return (['SCHEDULED', 'SKIPPED', 'NO_DATA', 'UNSCHEDULED'][value] ?? 'UNKNOWN') as StopScheduleRelationship;
}

function value(input?: string | null): string | undefined { return input || undefined; }
function present(object: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(object, key); }
function toNumber(input: number | { toString(): string }): number { return Number(input.toString()); }
