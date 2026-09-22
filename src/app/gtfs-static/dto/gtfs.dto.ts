export interface GtfsStaticTripCondensed {
  trip_id: string;
  route_id: string;
  trip_short_name: string;
  service_id: string;
  direction_id: string;
  shape_id: string;
  trip_headsign: string;
  arrival_time: string;
  arrival_day_minutes: number;
  departure_time: string;
  departure_day_minutes: number;
  stop_times_count: number;
  stop_times_s: string;
  original_trip_id: string;
}

export interface AgencyJSON {
  agency_id: string;
  agency_name: string;
  agency_url: string;
  agency_phone: string;
  agency_timezone: string;
  agency_lang: string;
}

export interface CalendarJSON {
  service_id: string;
  day_bits: string;
  start_date: string;
  end_date: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
}

export interface RouteJSON {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_desc: string;
  route_type: number;
  day_bits: string;
  representative_trip_id: string;
}

export interface StopJSON {
  stop_id: string;
  stop_name: string;
  stop_lon: number;
  stop_lat: number;
  location_type: string;
  parent_station: string;
}

export interface StopTimeJSON {
  stop_id: string;
  stop_arrival: Date | null;
  stop_departure: Date | null;
}

export interface TripJSON {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign: string | null;
  trip_short_name: string | null;
}

export interface GtfsDbLookupAgency {
  lookup_name: 'agency';
  data_source: string;
  rows: AgencyJSON[];
  rows_no: number;
}

export interface GtfsDbLookupRoutes {
  lookup_name: 'routes';
  data_source: string;
  rows: RouteJSON[];
  rows_no: number;
}

export interface GtfsDbLookupJSON {
  agency: GtfsDbLookupAgency;
  routes: GtfsDbLookupRoutes;
  stops: {
    lookup_name: 'stops';
    data_source: string;
    rows: StopJSON[];
    rows_no: number;
  };
}

export interface GtfsDbFtsRoutesLookupJSON {
  lookup_name: 'fts_routes';
  data_source: string;
  rows: Array<{ route_id: string; trip_stop_ids: string }>;
  rows_no: number;
}

export interface GtfsDbTripsResponse {
  metadata: { gtfs_day: string; rows_no: number };
  rows: GtfsStaticTripCondensed[];
}

export interface TripDetailResponseJSON {
  message: string[];
  result: {
    trip: GtfsStaticTripCondensed | null;
    calendar: CalendarJSON | null;
    route: RouteJSON | null;
    agency: AgencyJSON | null;
  };
}

export interface GtfsDayTripTimelineRow {
  trip_id: string;
  departure_day_minutes: number;
  arrival_day_minutes: number;
}

export interface GtfsDayTripTimelineResponse {
  rows: GtfsDayTripTimelineRow[];
}
