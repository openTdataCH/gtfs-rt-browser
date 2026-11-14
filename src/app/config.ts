export const APP_URLS = {
  gtfsRtFeed:
    'https://tools.opentransportdata.swiss/data/gtfs-rt/gtfs-rt-latest.pb',
  gtfsRtSnapshot: 'https://tools.opentransportdata.swiss/gtfs-rt-snapshot',
  gtfsCatalog: 'https://tools.opentransportdata.swiss/gtfs-static-dbs/gtfs-static-dbs.json',
  gtfsAgencyLookup: 'https://tools.opentransportdata.swiss/gtfs-query/lookup/agency',
  gtfsRoutesLookup: 'https://tools.opentransportdata.swiss/gtfs-query/lookup/routes',
  gtfsStopsLookup: 'https://tools.opentransportdata.swiss/gtfs-query/lookup/stops',
  gtfsTrip: 'https://tools.opentransportdata.swiss/gtfs-query/trip',
  gtfsDayTrips: 'https://tools.opentransportdata.swiss/gtfs-query/query_day_trips',
  gtfsChRoutes: 'https://gtfs.ch/routes',
  gtfsChTrips: 'https://api.gtfs.ch/v1/trips',

  shapesGraph: 'https://api.gtfs.ch/v1/shapes-data/versions/{gtfs_day}/shapes-data/trgraph.pmtiles',
  tripShapeEdgeMaps: 'https://api.gtfs.ch/v1/shapes-data/versions/{gtfs_day}/shapes-data/trip-shape-edge-maps.json',

  atlasBusinessOrganisations:
    'https://atlas.app.sbb.ch/business-organisation-directory/business-organisations',
  businessOrganisations:
    'https://tools.opentransportdata.swiss/data/actual_date_business_organisation_versions_LATEST.csv',
  goRealtime: 'https://tools.opentransportdata.swiss/data/go-realtime.csv'
} as const;

export function withGtfsDay(resourceUrl: string, gtfsDay: string): string {
  if (resourceUrl.includes('{gtfs_day}')) {
    return resourceUrl.replaceAll('{gtfs_day}', encodeURIComponent(gtfsDay));
  }

  const url = new URL(resourceUrl);
  url.searchParams.set('gtfs_day', gtfsDay);
  return url.toString();
}
