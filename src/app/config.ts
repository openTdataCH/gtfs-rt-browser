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
  atlasBusinessOrganisations:
    'https://atlas.app.sbb.ch/business-organisation-directory/business-organisations',
  businessOrganisations:
    'https://tools.opentransportdata.swiss/data/actual_date_business_organisation_versions_LATEST.csv'
} as const;
