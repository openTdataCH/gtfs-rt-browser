export interface GtfsStaticDbCatalogItemJSON {
  gtfs_datetime_s: string;
  gtfs_day: string;
  gtfs_rt_switch_datetime_s: string;
  table_stats: Record<string, number>;
  db_relative_path: string | null;
}

export interface GtfsStaticDbCatalogJSON {
  metadata: string;
  items: GtfsStaticDbCatalogItemJSON[];
}
