# GTFS-RT Browser

Angular browser for inspecting large GTFS-Realtime protobuf feeds. The initial
slice focuses on `TripUpdate` messages and mirrors the master/detail layout of
the SIRI-SX browser.

## Run

```bash
npm install
npm start
```

Open <http://localhost:4206>. The mock feed is read from
`data/mocks/gtfs-rt-fetch--data/gtfs-rt-latest.pb` and copied to the build as
`data/gtfs-rt-latest.pb`.

## Architecture

- `dto/` contains structured-clone-safe feed data.
- `models/` adds derived delay, status, search, and date behavior.
- `gtfs-rt-parser.worker.ts` decodes protobuf off the UI thread and emits
  `TripUpdate` DTOs in batches of 250.
- The UI uses Angular CDK virtual scrolling for the 10k+ message list.
