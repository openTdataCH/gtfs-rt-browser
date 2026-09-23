# GTFS-RT Browser

Browse and inspect GTFS-Realtime `TripUpdate` messages on an interactive timeline.
Search and filter trips by agency, route, relationship, and stop; compare updates
with GTFS static schedules, inspect stop times and delays, and open related OJP
requests. The app decodes large protobuf feeds in a worker to keep the UI responsive.

## Run

```bash
npm install
npm start
```

## Architecture

- `dto/` contains structured-clone-safe feed data.
- `models/` adds derived delay, status, search, and date behavior.
- `gtfs-rt-parser.worker.ts` decodes protobuf off the UI thread and emits
  `TripUpdate` DTOs in batches of 250.
