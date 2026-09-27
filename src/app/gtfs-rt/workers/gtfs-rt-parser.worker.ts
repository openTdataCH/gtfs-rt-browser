/// <reference lib="webworker" />

import GtfsRealtimeBindings, { transit_realtime } from 'gtfs-realtime-bindings';
import { APP_URLS } from '../../config';
import {
  BusinessOrganisationDto, FeedMetadataDto, StopScheduleRelationship, StopTimeEventDto,
  StopTimeUpdateDto, TripScheduleRelationship, TripTimelineUpdateDto, TripUpdateDto
} from '../dto';
import {
  AgencyJSON, GtfsDbLookupAgency, GtfsDbLookupRoutes, GtfsDbLookupStops, GtfsStaticDbCatalogItemJSON,
  GtfsStaticDbCatalogJSON, GtfsDayTripTimelineResponse,
  GtfsDayTripTimelineRow, RouteJSON
} from '../../gtfs-static/dto';

interface ParseRequest { type: 'parse'; url: string; }
interface DecodedFeed {
  readonly feed: transit_realtime.FeedMessage;
  readonly feedVersion: string;
  readonly originalTripIds: ReadonlyMap<string, string>;
}
interface LookupIndex {
  readonly routes: ReadonlyMap<string, RouteJSON>;
  readonly agencies: ReadonlyMap<string, AgencyJSON>;
  readonly businessOrganisations: ReadonlyMap<string, BusinessOrganisationDto>;
  readonly tripTimelines: ReadonlyMap<string, GtfsDayTripTimelineRow>;
  readonly feedDay: string;
}
const CHUNK_SIZE = 250;

addEventListener('message', ({ data }: MessageEvent<ParseRequest>) => {
  if (data.type === 'parse') void parseFeed(data.url);
});

async function parseFeed(url: string): Promise<void> {
  try {
    // Both sources are required before the GTFS-RT feed can be parsed.
    const [catalog, businessOrganisations] = await Promise.all([
      fetchGtfsCatalog(),
      fetchBusinessOrganisations()
    ]);
    console.info('GTFS static manifest and business organisations parsed.', {
      catalogItems: catalog.items.length,
      businessOrganisations: businessOrganisations.size
    });

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Feed request failed: ${response.status} ${response.statusText}`);
    const { feed, feedVersion: headerFeedVersion, originalTripIds } = await decodeFeed(response);
    const feedTimestamp = readRequiredFeedTimestamp(feed.header);
    const catalogItem = resolveCatalogItem(catalog, headerFeedVersion);
    const feedVersion = catalogItem.gtfs_day;
    const gtfsDay = feedVersion;
    const feedDay = formatSwissDay(feedTimestamp);
    const tripEntities = feed.entity.filter((entity) => entity.tripUpdate && !entity.isDeleted);
    const serviceDays = new Set([feedDay]);
    const tripTimelineKeys = new Set<string>();
    for (const entity of tripEntities) {
      const trip = entity.tripUpdate!.trip;
      const serviceDay = tripServiceDay(trip.startDate, feedDay);
      serviceDays.add(serviceDay);
      if (trip.tripId) tripTimelineKeys.add(tripTimelineKey(serviceDay, trip.tripId));
    }
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
    const stopsLookupPromise = fetchGtfsStopsLookup(gtfsDay)
      .then((stops) => {
        const stopsById = new Map(stops.rows.map((stop) => [stop.stop_id, stop]));
        postMessage({ type: 'stops-lookup', stopsById });
      })
      .catch((error: unknown) => postMessage({
        type: 'stops-error',
        message: error instanceof Error ? error.message : 'Unknown GTFS stops lookup error.'
      }));
    const tripTimelinesPromise = Promise.all([...serviceDays].map(async (day) => ({
      day, timelines: await fetchTripTimelines(gtfsDay, day)
    })))
      .then((timelines) => ({ timelines }))
      .catch((error: unknown) => ({ error }));

    const [agencyLookup, routesLookup] = await Promise.all([
      fetchGtfsLookup(APP_URLS.gtfsAgencyLookup, gtfsDay, 'agency'),
      fetchGtfsLookup(APP_URLS.gtfsRoutesLookup, gtfsDay, 'routes')
    ]);
    console.info('GTFS static lookups parsed.', {
      gtfsDay,
      agencies: agencyLookup.rows.length,
      routes: routesLookup.rows.length
    });
    const lookupIndex: LookupIndex = {
      routes: new Map(routesLookup.rows.map((route) => [route.route_id, route])),
      agencies: new Map(agencyLookup.rows.map((agency) => [agency.agency_id, agency])),
      businessOrganisations,
      tripTimelines: new Map(),
      feedDay
    };

    assertAgencySourcesPresent(tripEntities, lookupIndex);

    for (let index = 0; index < tripEntities.length; index += CHUNK_SIZE) {
      const updates = tripEntities.slice(index, index + CHUNK_SIZE)
        .map((entity) => toTripUpdateDto(entity, lookupIndex, originalTripIds.get(entity.id)));
      postMessage({ type: 'trip-updates', updates, processed: Math.min(index + CHUNK_SIZE, tripEntities.length) });
      await new Promise<void>((resolve) => setTimeout(resolve));
    }
    postMessage({ type: 'complete', count: tripEntities.length });
    const timelineResult = await tripTimelinesPromise;
    if ('timelines' in timelineResult) {
      const feedDayTimelines = timelineResult.timelines.find(({ day }) => day === feedDay)?.timelines;
      if (!feedDayTimelines) throw new Error(`GTFS day-trip timelines missing for feed day ${feedDay}.`);
      const agencyByRouteRowid = new Map(routesLookup.rows.map((route) => [route.rowid, route.agency_id]));
      const staticTripCountsByAgency = new Map<string, number>();
      const timeRangesByAgency = new Map<string, number[]>();
      // Summary counts remain for the feed day; other days supply timeline matches for their TripUpdates.
      for (const trip of feedDayTimelines.rows) {
        const agencyId = agencyByRouteRowid.get(trip.route_rowid);
        if (agencyId === undefined) {
          throw new Error(`GTFS day trip ${trip.trip_id} references unknown route rowid ${trip.route_rowid}.`);
        }
        staticTripCountsByAgency.set(agencyId, (staticTripCountsByAgency.get(agencyId) ?? 0) + 1);
        let timeRanges = timeRangesByAgency.get(agencyId);
        if (!timeRanges) {
          timeRanges = [];
          timeRangesByAgency.set(agencyId, timeRanges);
        }
        timeRanges.push(trip.departure_day_minutes, trip.arrival_day_minutes);
      }
      postMessage({ type: 'static-agency-trip-counts', countsByAgency: staticTripCountsByAgency, timeRangesByAgency });
      const tripTimelines = new Map<string, GtfsDayTripTimelineRow>();
      for (const { day, timelines } of timelineResult.timelines) {
        const offsetMinutes = dayOffsetMinutes(day, feedDay);
        for (const trip of timelines.rows) {
          const key = tripTimelineKey(day, trip.trip_id);
          if (!tripTimelineKeys.has(key)) continue;
          tripTimelines.set(key, {
            ...trip,
            departure_day_minutes: trip.departure_day_minutes + offsetMinutes,
            arrival_day_minutes: trip.arrival_day_minutes + offsetMinutes
          });
        }
      }
      const timelineLookups: LookupIndex = {
        ...lookupIndex,
        tripTimelines
      };
      const updates = tripEntities.map((entity) => toTripTimelineUpdateDto(entity, timelineLookups));
      postMessage({ type: 'trip-timelines', updates });
    } else {
      const error = timelineResult.error;
      postMessage({
        type: 'trip-timelines-error',
        message: error instanceof Error ? error.message : 'Unknown GTFS day-trip timeline error.'
      });
    }
    await stopsLookupPromise;
    postMessage({ type: 'worker-done' });
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

function tripServiceDay(startDate: string | null | undefined, feedDay: string): string {
  if (!startDate || !/^\d{8}$/.test(startDate)) return feedDay;
  const day = `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`;
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(day) ? day : feedDay;
}

function tripTimelineKey(day: string, tripId: string): string {
  return `${day}\0${tripId}`;
}

function dayOffsetMinutes(day: string, feedDay: string): number {
  return (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${feedDay}T00:00:00Z`)) / 60_000;
}

async function fetchTripTimelines(
  gtfsDay: string,
  serviceDay: string
): Promise<GtfsDayTripTimelineResponse> {
  const url = new URL(APP_URLS.gtfsDayTrips);
  url.searchParams.set('gtfs_day', gtfsDay);
  url.searchParams.set('day', serviceDay);
  url.searchParams.set('fields_profile', 'query_day_trips_timeline');
  url.searchParams.set('row_format', 'array');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GTFS day-trip timeline request failed for ${serviceDay}: ${response.status} ${response.statusText}`);
  }
  const json: unknown = await response.json();
  const rows = isRecord(json) ? json['rows'] : json;
  if (!isGtfsDayTripTimelineRows(rows)) {
    throw new Error(`GTFS day-trip timeline response for ${serviceDay} does not contain valid timeline rows.`);
  }
  const tripTimelines: GtfsDayTripTimelineResponse = {
    rows: rows.map(([trip_id, departure_day_minutes, arrival_day_minutes, route_rowid]) => ({
      trip_id, departure_day_minutes, arrival_day_minutes, route_rowid
    }))
  };
  console.info('GTFS day-trip timelines parsed.', {
    gtfsDay, serviceDay, trips: tripTimelines.rows.length
  });
  return tripTimelines;
}

function isGtfsDayTripTimelineRows(value: unknown): value is [string, number, number, number][] {
  return Array.isArray(value)
    && value.every((row) => Array.isArray(row) && row.length >= 4
      && typeof row[0] === 'string'
      && Number.isInteger(row[1])
      && Number.isInteger(row[2])
      && Number.isInteger(row[3]));
}

async function fetchBusinessOrganisations(): Promise<ReadonlyMap<string, BusinessOrganisationDto>> {
  const response = await fetch(APP_URLS.businessOrganisations);
  if (!response.ok) {
    throw new Error(`Business-organisation request failed: ${response.status} ${response.statusText}`);
  }
  const csv = await response.text();
  const rows = parseDelimited(csv.replace(/^\uFEFF/, ''), ';');
  const header = rows.shift();
  if (!header) throw new Error('Business-organisation CSV is empty.');
  const sboidIndex = header.indexOf('sboid');
  const organisationNumberIndex = header.indexOf('organisationNumber');
  const descriptionDeIndex = header.indexOf('descriptionDe');
  const abbreviationDeIndex = header.indexOf('abbreviationDe');
  if ([sboidIndex, organisationNumberIndex, descriptionDeIndex, abbreviationDeIndex]
    .some((index) => index < 0)) {
    throw new Error('Business-organisation CSV is missing required columns.');
  }

  const organisations = new Map<string, BusinessOrganisationDto>();
  for (const row of rows) {
    const organisationNumber = row[organisationNumberIndex]?.trim();
    if (!organisationNumber) continue;
    organisations.set(organisationNumber, {
      sboid: row[sboidIndex]?.trim() ?? '',
      organisationNumber,
      descriptionDe: row[descriptionDeIndex]?.trim() ?? '',
      abbreviationDe: row[abbreviationDeIndex]?.trim() ?? ''
    });
  }
  if (organisations.size === 0) throw new Error('Business-organisation CSV contains no organisations.');
  return organisations;
}

async function fetchGoRealtime(): Promise<{
  bySboid: ReadonlyMap<string, GoRealtimeDto>;
  byAgencyId: ReadonlyMap<string, GoRealtimeDto>;
}> {
  const response = await fetch(APP_URLS.goRealtime);
  if (!response.ok) throw new Error(`GO real-time request failed: ${response.status} ${response.statusText}`);
  const rows = parseDelimited((await response.text()).replace(/^\uFEFF/, ''), ';', 'GO real-time');
  const header = rows.shift();
  if (!header) throw new Error('GO real-time CSV is empty.');
  const columns = ['sboid', 'descriptionEn', 'abbreviationEn', 'vdvBetreiberId', 'source'];
  const indexes = columns.map((column) => header.indexOf(column));
  if (indexes.some((index) => index < 0)) throw new Error('GO real-time CSV is missing required columns.');

  const bySboid = new Map<string, GoRealtimeDto>();
  const byAgencyId = new Map<string, GoRealtimeDto>();
  for (const row of rows) {
    const [sboid, descriptionEn, abbreviationEn, vdvBetreiberId, source] = indexes
      .map((index) => row[index]?.trim() ?? '');
    if (!sboid && !vdvBetreiberId) continue;
    const entry = { sboid, descriptionEn, abbreviationEn, vdvBetreiberId, source };
    if (sboid) bySboid.set(sboid, entry);
    const agencyId = vdvBetreiberId.split(':').at(-1)?.trim();
    if (vdvBetreiberId.includes(':') && agencyId) byAgencyId.set(agencyId, entry);
  }
  if (bySboid.size === 0 && byAgencyId.size === 0) {
    throw new Error('GO real-time CSV contains no organisations.');
  }
  return { bySboid, byAgencyId };
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
  const url = new URL(APP_URLS.gtfsCatalog);
  url.searchParams.set('_ts', String(Date.now()));
  const response = await fetch(url, { cache: 'no-store' });
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

async function fetchGtfsStopsLookup(gtfsDay: string): Promise<GtfsDbLookupStops> {
  const url = new URL(APP_URLS.gtfsStopsLookup);
  url.searchParams.set('gtfs_day', gtfsDay);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GTFS stops lookup request failed: ${response.status} ${response.statusText}`);
  }
  const json: unknown = await response.json();
  if (!isLookup(json, 'stops')) {
    throw new Error('GTFS stops lookup response does not match the expected structure.');
  }
  return json as GtfsDbLookupStops;
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
    return { feed, feedVersion, originalTripIds: readBinaryOriginalTripIds(bytes) };
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
        feedVersion,
        originalTripIds: readJsonOriginalTripIds(json)
      };
    } catch {
      throw new Error(`Invalid GTFS-RT JSON FeedMessage: ${validationError}`);
    }
  }

  return {
    feed: GtfsRealtimeBindings.transit_realtime.FeedMessage.fromObject(json),
    feedVersion,
    originalTripIds: readJsonOriginalTripIds(json)
  };
}

function readJsonOriginalTripIds(feed: Record<string, unknown>): ReadonlyMap<string, string> {
  const originalTripIds = new Map<string, string>();
  if (!Array.isArray(feed['entity'])) return originalTripIds;
  for (const entity of feed['entity']) {
    if (!isRecord(entity) || typeof entity['id'] !== 'string') continue;
    const update = entity['tripUpdate'];
    const trip = isRecord(update) ? update['trip'] : undefined;
    if (!isRecord(trip)) continue;
    const originalTripId = trip['originalTripId'] ?? trip['original_trip_id'];
    if (typeof originalTripId === 'string' && originalTripId) {
      originalTripIds.set(entity['id'], originalTripId);
    }
  }
  return originalTripIds;
}

/** Reads Swiss TripDescriptor field 8, which the standard GTFS-RT bindings omit. */
function readBinaryOriginalTripIds(feedBytes: Uint8Array): ReadonlyMap<string, string> {
  const originalTripIds = new Map<string, string>();
  let offset = 0;
  while (offset < feedBytes.length) {
    const tag = readVarint(feedBytes, offset);
    offset = tag.offset;
    if (Number(tag.value >> 3n) === 2 && Number(tag.value & 7n) === 2) {
      const entity = readLengthDelimited(feedBytes, offset);
      const entityId = readProtobufStringField(entity.value, 1);
      const update = readProtobufMessageField(entity.value, 3);
      const trip = update && readProtobufMessageField(update, 1);
      const originalTripId = trip && readProtobufStringField(trip, 8);
      if (entityId && originalTripId) originalTripIds.set(entityId, originalTripId);
      offset = entity.offset;
    } else {
      offset = skipWireValue(feedBytes, offset, Number(tag.value & 7n));
    }
  }
  return originalTripIds;
}

function readProtobufStringField(bytes: Uint8Array, fieldNumber: number): string | undefined {
  const field = readProtobufMessageField(bytes, fieldNumber);
  return field ? new TextDecoder('utf-8', { fatal: true }).decode(field) : undefined;
}

function readProtobufMessageField(bytes: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const wireType = Number(tag.value & 7n);
    if (Number(tag.value >> 3n) === fieldNumber && wireType === 2) {
      return readLengthDelimited(bytes, offset).value;
    }
    offset = skipWireValue(bytes, offset, wireType);
  }
  return undefined;
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

function toTripUpdateDto(
  entity: transit_realtime.FeedEntity,
  lookups: LookupIndex,
  originalTripId?: string
): TripUpdateDto {
  const update = entity.tripUpdate!;
  const trip = update.trip;
  const route = trip.routeId ? lookups.routes.get(trip.routeId) : undefined;
  const agency = route ? lookups.agencies.get(route.agency_id) : undefined;
  const businessOrganisation = route
    ? lookups.businessOrganisations.get(route.agency_id)
    : undefined;
  return {
    entityId: entity.id,
    trip: {
      tripId: value(trip.tripId), routeId: value(trip.routeId),
      originalTripId,
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
    route,
    businessOrganisation,
    staticTripAvailable: false
  };
}

function toTripTimelineUpdateDto(
  entity: transit_realtime.FeedEntity,
  lookups: LookupIndex
): TripTimelineUpdateDto {
  const update = entity.tripUpdate!;
  const trip = update.trip;
  const route = trip.routeId ? lookups.routes.get(trip.routeId) : undefined;
  const timeline = trip.tripId
    ? lookups.tripTimelines.get(tripTimelineKey(tripServiceDay(trip.startDate, lookups.feedDay), trip.tripId))
    : undefined;
  const result = route
    ? staticTimelineResult(trip.tripId, timeline, update.stopTimeUpdate, lookups.feedDay)
    : realtimeTimelineResult(update.stopTimeUpdate, lookups.feedDay);
  return {
    entityId: entity.id,
    staticTripAvailable: timeline !== undefined,
    timeline: result.timeline,
    timelineError: result.error
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
