# Offline area setup and map packs

The shared setup now supports the Android walking pilot and web companion. It includes local place/manual selection, directed path-interior routes and foreground guidance. Safe-destination semantics, signed hazards and BLE remain separate work. See [Android scope and release gates](ANDROID_RELEASE.md).

## User flow

1. Search a city/area, or explicitly request location to find a containing supported pack. Coordinates are not sent to an application server. An unsupported location stays a manual-selection case; the app does not pretend a nearby pack contains the user.
2. Inspect the actual coverage outline, source date, and measured map-file size.
3. Download, pause, and resume. A stopped browser session leaves its checkpoint available. A second active tab cannot write the same region concurrently.
4. Verify each file, then atomically activate the generation. A failed replacement leaves the previous installed map available.
5. Reopen the production app offline, read its saved map, run a local file check, or remove the area. Missing or damaged files withdraw readiness and can be repaired.

Prayagraj is an 841.80 km? city-area rectangle (9,878,890 bytes / 1,003 files), including named Naini/Jhunsi/Phaphamau coverage. Three Delhi/Noida packs remain bounded starter neighborhoods. None claims a district or official administrative boundary. Source snapshots and data attribution are committed. The vector preview is bundled with the app shell; downloading the full map and graph remains a user action.

## Trust and integrity

`apps/web/src/generated/catalog.json` is bundled with the trusted app release. Each entry pins a manifest SHA-256, dataset identity, coverage, profile, timestamp, and total file bytes. A manifest lists every allowed asset path, size, type, and hash. Unknown versions, profiles, generations, paths and totals are rejected.

This is an application-release trust model: the initial HTTPS app origin and its deployed code must be trusted. File hashes do not defend against malicious replacement of the application itself. There is no client-side signing secret and no claim that an unauthenticated, freely replaceable manifest is trustworthy.

The content-addressed dataset identity includes the source checksum, profile, tile version, coverage and asset hashes. Assets live at `/packs/<region>/<generation>/`. Existing generations are never overwritten by the publisher. The app never loads a map from a staged generation through its active-region pointer.

## Storage and recovery

`@offgrid/maps` defines a shared storage contract. The web implementation stores installed pointers, verified assets, partial blobs, journals, generations and leases in IndexedDB. Android stores them in private native SQLite, with bounded binary chunks/batches and a native SHA-256 check before activation. Committing an installed pointer and ready journal is one transaction. A failed update does not remove the previous pointer. Successful replacement prunes the previous generation; removing a region also removes abandoned staged generations.

Leases are transactional, refreshed while the operation runs, and expire after a crashed writer. Writes use a valid exclusive lease, renewed at most every five seconds during progress and by a heartbeat during network waits. Returning from suspension or a clock jump forces renewal; another cooperating writer cannot acquire the lease before expiry. A pending heartbeat finishes before the owner releases its lease. A stale verification failure compares the generation and activation timestamp; it cannot withdraw a newly activated repair or replacement.

Resume requests use `Range: bytes=<saved-prefix>-`. A `206` must have the expected `Content-Range`; a server that sends `200` restarts that file. A complete saved prefix can be verified after `416`. Final size/hash/structure validation is mandatory. A failed completed hash discards the prefix and permits one bounded clean retry. Ordinary interruptions preserve the prefix. The old installed generation is unaffected.

The browser's storage estimate is a preflight aid, not a reservation. Actual quota/write failures remain recoverable errors. Persistence can be denied. Every startup rechecks installed files locally, and users can run the same check manually. Browser storage can be cleared by the user or evicted. Native map data is outside WebView cache, excluded from backup/transfer and retained through process death; uninstall/user data clearing removes it. Both implementations still validate actual file contents.

## Offline shell

The production build creates a versioned service worker and precaches HTML, hashed JavaScript/CSS, local fonts and icons. Pack downloads bypass its response cache: map data belongs in IndexedDB. Cached shell paths ignore `Vary` because a server's `Vary: Origin` must not hide a previously cached own-origin module on offline reload.

New app workers wait until the user accepts an update. The update action is disabled during active downloads; saved maps are retained. Hashed asset responses from older shell caches remain usable while another old tab exists. Development mode does not register the offline worker; use a production preview or HTTPS deployment to exercise offline reopening.

## Rebuilding and adding coverage

```sh
pnpm packs:build
pnpm build
pnpm test:packs
```

Rebuilds use `data/raw/<area>.json` when present, otherwise the committed gzip snapshot in `packages/pipeline/snapshots`. No network access is needed. The publisher writes deterministic manifests and a catalogue only for sources that exist. CI regenerates and compares the published files and fixtures.

To fetch a new bounded snapshot deliberately:

```sh
python packages/pipeline/fetch_starter_regions.py --refresh --region central-delhi --save-snapshots
pnpm packs:build
pnpm test:packs
```

To add an area, add its bounds and factual names to `starter-regions.json`, fetch and freeze its source, rebuild, then inspect coverage and run the published-pack checks. Public OSM services may fail or limit requests; a failed fetch preserves the existing source. Region configuration bounds source response size and request time; Prayagraj also fetches available named stations, suburbs and selected public-service places. Larger city packs need appropriately split visual assets and device storage/performance validation; the current per-asset limit is 32 MiB and each manifest must stay below 4 MiB.

The starter publisher uses a separate conservative `walking-v1` profile, respects explicit foot access and available node barrier/access tags, includes pedestrian links, ignores vehicle-only oneway tags and applies `oneway:foot`. High-speed roads require explicit pedestrian permission. Walking simplification retains way boundaries so different speeds cannot be averaged across an edge-interior start. Explicit temporary/seasonal/pontoon/floating/ford and unevaluated conditional-access/opening-hours restrictions are excluded. This still does not model every jurisdiction, accessibility requirement, entrance, crossing condition or live closure. The legacy PBF build CLI retains its motor profile. Neither profile is a field safety certification.

## Verification

- Unit tests cover integrity failures, storage estimates, prefix resume, ignored/wrong ranges, complete-prefix recovery, rollback, conflicting writers, cleanup and readiness invalidation.
- Precision regressions compare 3,545 serialized queries with independent Python costs and verify heuristic consistency and reconstructed path costs.
- Published-pack checks hash every current file and compare 60 routes per real OSM starter pack with reference Dijkstra.
- Desktop and emulated Pixel 7 browser tests exercise selection, offline reload, local verification, removal, damaged-download repair, location boundaries and throttled pause/resume with actual Range requests.
- Real phones, browsers other than the tested Chromium engine, full-city Delhi data, background BLE and emergency field conditions still require separate acceptance work.


## Walking application view

The worker verifies each routing tile before use. Start/destination projections retain both permitted directions of the same physical path, reject ambiguous overlapping unconnected paths, and connect through the proven router. Parallel-road geometry follows the selected minimum base-cost edge. No hazard overlay is enabled in this release; a future overlay needs physical-edge identity and corresponding reconstruction tests.

A coverage-restricted graph view excludes edges whose endpoints or shape leave the selected rectangle. This is conservative: a long simplified edge that leaves coverage is excluded as a whole, including any interior covered fragment. Build-time geometric clipping and demand-driven larger-region loading remain improvements. A missing/capped search never becomes a claimed complete route.

Source snapshots retain observed tags, not guarantees about current field conditions. City rendering groups road classes to bound DOM size. Large basemap blobs use chunked native reads; small graph tiles use bounded native batches. Each complete pack is verified before activation and again after reopening. Manual checks and repair remain available.
