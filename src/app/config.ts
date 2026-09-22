export const APP_URLS = {
  gtfsRtFeed:
    'https://tools.opentransportdata.swiss/data/gtfs-rt/gtfs-rt-latest.pb',
  gtfsCatalog: 'https://tools.opentransportdata.swiss/gtfs-static-dbs/gtfs-static-dbs.json',
  gtfsAgencyLookup: 'https://tools.opentransportdata.swiss/gtfs-query/lookup/agency',
  gtfsRoutesLookup: 'https://tools.opentransportdata.swiss/gtfs-query/lookup/routes',
  gtfsDayTrips: 'https://tools.opentransportdata.swiss/gtfs-query/query_day_trips',
  gtfsChRoutes: 'https://gtfs.ch/routes',
  businessOrganisations:
    'https://tools.opentransportdata.swiss/data/actual_date_business_organisation_versions_LATEST.csv'
} as const;
