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

## URL parameters

| Parameter | Purpose |
| --- | --- |
| `agency` | Select an agency after the feed loads. Matches an exact business-organisation SBOID first, then an exact GTFS-static `agency_id`, among agencies present in the feed. Changing the agency dropdown updates this parameter using the GTFS `agency_id`. |
| `q` | Search the loaded messages by trip, route, vehicle, agency, SBOID, or stop ID. This does not select the agency dropdown. Editing the search box updates this parameter. |
| `active` | Enable **Active trips** at startup with `yes`, `1`, or `true` (case-insensitive). The checkbox writes `active=yes` when enabled and removes the parameter when disabled. |
| `route_type` | Filter by a numeric GTFS route type, such as `101`. The parameter is absent for **All route types** and **missing route type**. |
| `status` | Filter by GTFS-RT trip schedule relationship, such as `SCHEDULED`, `ADDED`, or `CANCELED`. The dropdown updates this parameter and removes it for **All relationships**. |

For example, `?agency=ch:1:sboid:100001&active=yes&route_type=101&status=SCHEDULED&q=ch:1:sloid:7000`
selects an agency and applies the other filters. The displayed **Now** time is
not a URL parameter; it starts at the OS time and can be changed in the UI.

## Architecture

- `dto/` contains structured-clone-safe feed data.
- `models/` adds derived delay, status, search, and date behavior.
- `gtfs-rt-parser.worker.ts` decodes protobuf off the UI thread and emits
  `TripUpdate` DTOs in batches of 250.
