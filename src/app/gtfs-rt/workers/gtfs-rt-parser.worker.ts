/// <reference lib="webworker" />

import GtfsRealtimeBindings, { transit_realtime } from 'gtfs-realtime-bindings';
import {
  BusinessOrganisationDto, FeedMetadataDto, StopScheduleRelationship, StopTimeEventDto,
  StopTimeUpdateDto, TripScheduleRelationship, TripUpdateDto
} from '../dto';
import {
  AgencyJSON, GtfsDbLookupAgency, GtfsDbLookupRoutes, GtfsStaticDbCatalogItemJSON,
  GtfsStaticDbCatalogJSON, GtfsDayTripTimelineResponse,
  GtfsDayTripTimelineRow, RouteJSON
} from '../../gtfs-static/dto';

interface ParseRequest { type: 'parse'; url: string; }
interface DecodedFeed {
  readonly feed: transit_realtime.FeedMessage;
  readonly feedVersion: string;
}
interface LookupIndex {
  readonly routes: ReadonlyMap<string, RouteJSON>;
  readonly agencies: ReadonlyMap<string, AgencyJSON>;
  readonly businessOrganisations: ReadonlyMap<string, BusinessOrganisationDto>;
  readonly tripTimelines: ReadonlyMap<string, GtfsDayTripTimelineRow>;
  readonly feedDay: string;
}
const CHUNK_SIZE = 250;
const GTFS_CATALOG_URL = 'https://tools.opentransportdata.swiss/gtfs-static-dbs/gtfs-static-dbs.json';
const GTFS_AGENCY_LOOKUP_URL = 'https://tools.opentransportdata.swiss/gtfs-query/lookup/agency';
const GTFS_ROUTES_LOOKUP_URL = 'https://tools.opentransportdata.swiss/gtfs-query/lookup/routes';
const BUSINESS_ORGANISATIONS_URL =
  'https://tools.opentransportdata.swiss/data/actual_date_business_organisation_versions_LATEST.csv';
const GTFS_DAY_TRIPS_URL =
  'https://tools.opentransportdata.swiss/gtfs-query/query_day_trips';

addEventListener('message', ({ data }: MessageEvent<ParseRequest>) => {
  if (data.type === 'parse') void parseFeed(data.url);
});

async function parseFeed(url: string): Promise<void> {
  try {
    // The catalog is intentionally the first awaited application dependency.
    const catalog = await fetchGtfsCatalog();
    console.info('GTFS static manifest parsed.', { items: catalog.items.length });

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Feed request failed: ${response.status} ${response.statusText}`);
    const { feed, feedVersion: headerFeedVersion } = await decodeFeed(response);
    const feedTimestamp = readRequiredFeedTimestamp(feed.header);
    const catalogItem = resolveCatalogItem(catalog, headerFeedVersion);
    const feedVersion = catalogItem.gtfs_day;
    const gtfsDay = feedVersion;
    const feedDay = formatSwissDay(feedTimestamp);
    const [agencyLookup, routesLookup] = await Promise.all([
      fetchGtfsLookup(GTFS_AGENCY_LOOKUP_URL, gtfsDay, 'agency'),
      fetchGtfsLookup(GTFS_ROUTES_LOOKUP_URL, gtfsDay, 'routes')
    ]);
    const businessOrganisations = await fetchBusinessOrganisations();
    const tripTimelines = await fetchTripTimelines(gtfsDay, feedDay);
    console.info('GTFS static lookups parsed.', {
      gtfsDay,
      agencies: agencyLookup.rows.length,
      routes: routesLookup.rows.length
    });
    const lookupIndex: LookupIndex = {
      routes: new Map(routesLookup.rows.map((route) => [route.route_id, route])),
      agencies: new Map(agencyLookup.rows.map((agency) => [agency.agency_id, agency])),
      businessOrganisations,
      tripTimelines: new Map(tripTimelines.rows.map((trip) => [trip.trip_id, trip])),
      feedDay
    };

    const tripEntities = feed.entity.filter((entity) => entity.tripUpdate && !entity.isDeleted);
    assertAgencySourcesPresent(tripEntities, lookupIndex);

    const metadata: FeedMetadataDto = {
      feedVersion,
      feedDay,
      gtfsRealtimeVersion: feed.header.gtfsRealtimeVersion,
      incrementality: ['FULL_DATASET', 'DIFFERENTIAL'][feed.header.incrementality] as FeedMetadataDto['incrementality'] ?? 'UNKNOWN',
      timestamp: feedTimestamp,
      entityCount: feed.entity.length,
      tripUpdateCount: tripEntities.length
    };
    postMessage({ type: 'metadata', metadata });

    for (let index = 0; index < tripEntities.length; index += CHUNK_SIZE) {
      const updates = tripEntities.slice(index, index + CHUNK_SIZE)
        .map((entity) => toTripUpdateDto(entity, lookupIndex));
      postMessage({ type: 'trip-updates', updates, processed: Math.min(index + CHUNK_SIZE, tripEntities.length) });
      await new Promise<void>((resolve) => setTimeout(resolve));
    }
    postMessage({ type: 'complete', count: tripEntities.length });
  } catch (error: unknown) {
    postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unknown GTFS-RT parsing error.' });
  }
}

function formatSwissDay(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values['year']}-${values['month']}-${values['day']}`;
}

async function fetchTripTimelines(
  gtfsDay: string,
  feedDay: string
): Promise<GtfsDayTripTimelineResponse> {
  const url = new URL(GTFS_DAY_TRIPS_URL);
  url.searchParams.set('gtfs_day', gtfsDay);
  url.searchParams.set('day', feedDay);
  url.searchParams.set('fields_profile', 'query_day_trips_timeline');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GTFS day-trip timeline request failed: ${response.status} ${response.statusText}`);
  }
  const json: unknown = await response.json();
  if (!isGtfsDayTripTimelineResponse(json)) {
    throw new Error('GTFS day-trip timeline response does not contain valid timeline rows.');
  }
  console.info('GTFS day-trip timelines parsed.', {
    gtfsDay, feedDay, trips: json.rows.length
  });
  return json;
}

function isGtfsDayTripTimelineResponse(value: unknown): value is GtfsDayTripTimelineResponse {
  return isRecord(value)
    && Array.isArray(value['rows'])
    && value['rows'].every((row) => isRecord(row)
      && typeof row['trip_id'] === 'string'
      && Number.isInteger(row['departure_day_minutes'])
      && Number.isInteger(row['arrival_day_minutes']));
}

async function fetchBusinessOrganisations(): Promise<ReadonlyMap<string, BusinessOrganisationDto>> {
  const response = await fetch(BUSINESS_ORGANISATIONS_URL);
  if (!response.ok) {
    throw new Error(`Business-organisation request failed: ${response.status} ${response.statusText}`);
  }
  const csv = await response.text();
  const rows = parseDelimited(csv.replace(/^\uFEFF/, ''), ';');
  const header = rows.shift();
  if (!header) throw new Error('Business-organisation CSV is empty.');
  const organisationNumberIndex = header.indexOf('organisationNumber');
  const descriptionDeIndex = header.indexOf('descriptionDe');
  const abbreviationDeIndex = header.indexOf('abbreviationDe');
  if ([organisationNumberIndex, descriptionDeIndex, abbreviationDeIndex].some((index) => index < 0)) {
    throw new Error('Business-organisation CSV is missing required columns.');
  }

  const organisations = new Map<string, BusinessOrganisationDto>();
  for (const row of rows) {
    const organisationNumber = row[organisationNumberIndex]?.trim();
    if (!organisationNumber) continue;
    organisations.set(organisationNumber, {
      organisationNumber,
      descriptionDe: row[descriptionDeIndex]?.trim() ?? '',
      abbreviationDe: row[abbreviationDeIndex]?.trim() ?? ''
    });
  }
  if (organisations.size === 0) throw new Error('Business-organisation CSV contains no organisations.');
  return organisations;
}

function assertAgencySourcesPresent(
  entities: readonly transit_realtime.FeedEntity[],
  lookups: LookupIndex
): void {
  const missing = new Set<string>();
  for (const entity of entities) {
    const routeId = entity.tripUpdate?.trip.routeId;
    const route = routeId ? lookups.routes.get(routeId) : undefined;
    if (route
      && !lookups.businessOrganisations.has(route.agency_id)
      && !lookups.agencies.has(route.agency_id)) {
      missing.add(route.agency_id);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `No business organisation or GTFS agency found for agency_id: ${[...missing].sort().join(', ')}.`
    );
  }
}

function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Business-organisation CSV contains an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function readRequiredFeedTimestamp(header: transit_realtime.FeedHeader): number {
  if (!present(header, 'timestamp')) {
    throw new Error('GTFS-RT header is missing the required timestamp used as application time.');
  }
  const timestamp = toNumber(header.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error(`GTFS-RT header timestamp "${timestamp}" is invalid.`);
  }
  return timestamp;
}

async function fetchGtfsCatalog(): Promise<GtfsStaticDbCatalogJSON> {
  const response = await fetch(GTFS_CATALOG_URL);
  if (!response.ok) {
    throw new Error(`GTFS static manifest request failed: ${response.status} ${response.statusText}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`GTFS static manifest could not be decoded: ${reason}`);
  }
  if (!isGtfsStaticDbCatalogJSON(json)) {
    throw new Error('GTFS static manifest does not match the expected catalog structure.');
  }
  if (json.items.length === 0) {
    throw new Error('GTFS static manifest does not contain any items.');
  }
  return json;
}

function resolveCatalogItem(
  catalog: GtfsStaticDbCatalogJSON,
  headerFeedVersion: string
): GtfsStaticDbCatalogItemJSON {
  const gtfsDay = formatGtfsDay(headerFeedVersion);
  const item = catalog.items.find((candidate) => candidate.gtfs_day === gtfsDay);
  if (!item) {
    throw new Error(`No GTFS static manifest entry exists for gtfs_version ${gtfsDay}.`);
  }

  if (item.db_relative_path === null) {
    throw new Error(`GTFS static manifest entry ${item.gtfs_day} has no database (db_relative_path is null).`);
  }
  return item;
}

function isGtfsStaticDbCatalogJSON(value: unknown): value is GtfsStaticDbCatalogJSON {
  return isRecord(value)
    && typeof value['metadata'] === 'string'
    && Array.isArray(value['items'])
    && value['items'].every(isGtfsStaticDbCatalogItemJSON);
}

function isGtfsStaticDbCatalogItemJSON(value: unknown): value is GtfsStaticDbCatalogItemJSON {
  return isRecord(value)
    && typeof value['gtfs_datetime_s'] === 'string'
    && typeof value['gtfs_day'] === 'string'
    && typeof value['gtfs_rt_switch_datetime_s'] === 'string'
    && isRecord(value['table_stats'])
    && (typeof value['db_relative_path'] === 'string' || value['db_relative_path'] === null);
}

function formatGtfsDay(feedVersion: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(feedVersion);
  if (!match) {
    throw new Error(`Invalid GTFS-RT gtfs_version "${feedVersion}": expected YYYYMMDD.`);
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)) {
    throw new Error(`Invalid GTFS-RT gtfs_version "${feedVersion}": expected a valid YYYYMMDD date.`);
  }

  return `${year}-${month}-${day}`;
}

function fetchGtfsLookup(
  endpoint: string,
  gtfsDay: string,
  lookupName: 'agency'
): Promise<GtfsDbLookupAgency>;
function fetchGtfsLookup(
  endpoint: string,
  gtfsDay: string,
  lookupName: 'routes'
): Promise<GtfsDbLookupRoutes>;
async function fetchGtfsLookup(
  endpoint: string,
  gtfsDay: string,
  lookupName: 'agency' | 'routes'
): Promise<GtfsDbLookupAgency | GtfsDbLookupRoutes> {
  const url = new URL(endpoint);
  url.searchParams.set('gtfs_day', gtfsDay);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GTFS ${lookupName} lookup request failed: ${response.status} ${response.statusText}`);
  }

  const json: unknown = await response.json();
  if (!isLookup(json, lookupName)) {
    throw new Error(`GTFS ${lookupName} lookup response does not match the expected structure.`);
  }
  return json as GtfsDbLookupAgency | GtfsDbLookupRoutes;
}

function isLookup(value: unknown, name: string): boolean {
  return isRecord(value)
    && value['lookup_name'] === name
    && typeof value['data_source'] === 'string'
    && Array.isArray(value['rows'])
    && typeof value['rows_no'] === 'number';
}

async function decodeFeed(response: Response): Promise<DecodedFeed> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
  const isJsonMime = contentType.includes('application/json') || contentType.includes('+json');
  const isJsonBody = firstNonWhitespaceByte(bytes) === 0x7b || firstNonWhitespaceByte(bytes) === 0x5b;

  if (!isJsonMime && !isJsonBody) {
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
    const feedVersion = readBinaryGtfsVersion(bytes);
    if (!feedVersion) throw new Error('GTFS-RT protobuf header is missing required gtfs_version field 4.');
    return { feed, feedVersion };
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

  if (!isRecord(json['header'])) throw new Error('GTFS-RT response is missing its header.');
  const feedVersion = readRequiredFeedVersion(json['header']);

  const validationError = GtfsRealtimeBindings.transit_realtime.FeedMessage.verify(json);
  if (validationError) {
    // fromObject also accepts protobuf JSON enum names and 64-bit integer strings,
    // which verify() intentionally rejects because it expects wire-shaped values.
    try {
      return {
        feed: GtfsRealtimeBindings.transit_realtime.FeedMessage.fromObject(json),
        feedVersion
      };
    } catch {
      throw new Error(`Invalid GTFS-RT JSON FeedMessage: ${validationError}`);
    }
  }

  return {
    feed: GtfsRealtimeBindings.transit_realtime.FeedMessage.fromObject(json),
    feedVersion
  };
}

function readRequiredFeedVersion(header: object): string {
  const values = header as Record<string, unknown>;
  const feedVersion = values['feedVersion'] ?? values['gtfsVersion'] ?? values['gtfs_version'];
  if (feedVersion === undefined || feedVersion === null) {
    throw new Error('GTFS-RT JSON header is missing required gtfs_version.');
  }
  if (typeof feedVersion !== 'string' || !feedVersion.trim())
    throw new Error('GTFS-RT header gtfs_version must be a non-empty string.');
  return feedVersion.trim();
}

/** Reads custom FeedHeader field 4 (`gtfs_version`) skipped by the standard bindings. */
function readBinaryGtfsVersion(feedBytes: Uint8Array): string | undefined {
  let offset = 0;
  while (offset < feedBytes.length) {
    const tag = readVarint(feedBytes, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);

    if (fieldNumber === 1 && wireType === 2) {
      const header = readLengthDelimited(feedBytes, offset);
      return readHeaderGtfsVersion(header.value);
    }
    offset = skipWireValue(feedBytes, offset, wireType);
  }
  throw new Error('GTFS-RT protobuf is missing its FeedHeader.');
}

function readHeaderGtfsVersion(headerBytes: Uint8Array): string | undefined {
  let offset = 0;
  while (offset < headerBytes.length) {
    const tag = readVarint(headerBytes, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);

    if (fieldNumber === 4) {
      if (wireType !== 2) throw new Error('GTFS-RT header gtfs_version has an invalid wire type.');
      const field = readLengthDelimited(headerBytes, offset);
      const value = new TextDecoder('utf-8', { fatal: true }).decode(field.value).trim();
      if (!value) throw new Error('GTFS-RT header gtfs_version is empty.');
      return value;
    }
    offset = skipWireValue(headerBytes, offset, wireType);
  }
  return undefined;
}

function readLengthDelimited(bytes: Uint8Array, offset: number): { value: Uint8Array; offset: number } {
  const length = readVarint(bytes, offset);
  const size = Number(length.value);
  const end = length.offset + size;
  if (!Number.isSafeInteger(size) || end > bytes.length) {
    throw new Error('Invalid length-delimited protobuf field.');
  }
  return { value: bytes.subarray(length.offset, end), offset: end };
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length && shift < 70n) {
    const byte = bytes[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error('Invalid protobuf varint.');
}

function skipWireValue(bytes: Uint8Array, offset: number, wireType: number): number {
  if (wireType === 0) return readVarint(bytes, offset).offset;
  if (wireType === 1) return checkedOffset(bytes, offset + 8);
  if (wireType === 2) return readLengthDelimited(bytes, offset).offset;
  if (wireType === 5) return checkedOffset(bytes, offset + 4);
  throw new Error(`Unsupported protobuf wire type ${wireType}.`);
}

function checkedOffset(bytes: Uint8Array, offset: number): number {
  if (offset > bytes.length) throw new Error('Truncated protobuf field.');
  return offset;
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

function toTripUpdateDto(entity: transit_realtime.FeedEntity, lookups: LookupIndex): TripUpdateDto {
  const update = entity.tripUpdate!;
  const trip = update.trip;
  const route = trip.routeId ? lookups.routes.get(trip.routeId) : undefined;
  const agency = route ? lookups.agencies.get(route.agency_id) : undefined;
  const businessOrganisation = route
    ? lookups.businessOrganisations.get(route.agency_id)
    : undefined;
  const timeline = trip.tripId ? lookups.tripTimelines.get(trip.tripId) : undefined;
  const timelineResult = route
    ? staticTimelineResult(trip.tripId, timeline, update.stopTimeUpdate, lookups.feedDay)
    : realtimeTimelineResult(update.stopTimeUpdate, lookups.feedDay);
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
    delay: present(update, 'delay') ? update.delay : undefined,
    agencyId: route?.agency_id,
    agency,
    businessOrganisation,
    timeline: timelineResult.timeline,
    timelineError: timelineResult.error
  };
}

function staticTimelineResult(
  tripId: string | undefined,
  timeline: GtfsDayTripTimelineRow | undefined,
  stops: readonly transit_realtime.TripUpdate.IStopTimeUpdate[],
  feedDay: string
): { timeline?: TripUpdateDto['timeline']; error?: string } {
  if (timeline) {
    return { timeline: {
      departureDayMinutes: timeline.departure_day_minutes,
      arrivalDayMinutes: timeline.arrival_day_minutes
    } };
  }

  const realtime = realtimeTimelineResult(stops, feedDay);
  if (realtime.timeline) return realtime;
  return {
    error: `${tripId ? `No static timeline found for trip_id ${tripId}. ` : 'TripUpdate has no trip_id. '}${realtime.error}`
  };
}

function realtimeTimelineResult(
  stops: readonly transit_realtime.TripUpdate.IStopTimeUpdate[],
  feedDay: string
): { timeline?: TripUpdateDto['timeline']; error?: string } {
  if (stops.length === 0) return { error: 'TripUpdate has no realtime stop_time_update entries.' };
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first.departure || !present(first.departure, 'time')) {
    return { error: 'First realtime stop_time_update has no departure time.' };
  }
  if (!last.arrival || !present(last.arrival, 'time')) {
    return { error: 'Last realtime stop_time_update has no arrival time.' };
  }
  return { timeline: {
    departureDayMinutes: swissDayMinutes(toNumber(first.departure.time!), feedDay),
    arrivalDayMinutes: swissDayMinutes(toNumber(last.arrival.time!), feedDay)
  } };
}

function swissDayMinutes(timestamp: number, feedDay: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp * 1000)).map((part) => [part.type, part.value]));
  const date = `${parts['year']}-${parts['month']}-${parts['day']}`;
  const dayOffset = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${feedDay}T00:00:00Z`)) / 86_400_000;
  return dayOffset * 1_440 + Number(parts['hour']) * 60 + Number(parts['minute']) + Number(parts['second']) / 60;
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
