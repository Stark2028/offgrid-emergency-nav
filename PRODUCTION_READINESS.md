# Production readiness review

Reviewed 2026-10-27. **OffGrid is a routing prototype, not a field-ready emergency navigation product.** This review hardens the existing core; it does not certify emergency use or validate the planned mobile transports.

## Fixed in this review

| Finding | Impact | Change and verification |
| --- | --- | --- |
| Backward searches reversed hazard callback endpoints | Directional penalties could select a different route from forward Dijkstra | Apply callbacks in original travel direction; compare every reachable fixture pair under asymmetric penalties; verify reverse multi-source search against forward single-source results |
| Heap priorities were `Uint32Array` | Accumulated costs and doubled A* keys above 2^32 silently wrapped | Use `Float64Array`, reject unsafe/non-integer priorities and invalid node indexes; regression across the u32 boundary |
| Budget exhaustion looked like no route, or an ordinary completed route | Callers could present an unfinished search as definitive | Explicit `complete`, `missing-tiles`, and `budget-exceeded` statuses; validate budgets; record missing endpoints and discovered halo nodes before frontier termination |
| Hazard weight contract was documentation only | NaN, negative, discounted, infinite, fractional, or excessive penalties could corrupt ordering or violate the threat model | Require integer costs between the base weight and 20 times it; regression tests for invalid results |
| Tile ingestion trusted body counts, CSR arrays, and geometry | Corrupt downloads/storage could cause exceptions deep inside routing or silent malformed edges | Validate layout before constructing views, then coordinates, sorted IDs, flags, CSR sentinels/offsets, halo adjacency, targets, positive weights, and geometry record boundaries |
| TileSet silently overwrote owned node indexes | Mixed graphs could corrupt resolution and eviction | Reject conflicting owners atomically; require explicit removal before replacing a resident cell |
| Geometry interning used endpoints alone | Parallel roads could inherit another road's shape | Include canonical interior shape in the key while preserving reverse sharing; regenerate affected ladder fixtures |
| Serializer clamped weights/components and truncated shapes | Invalid input was silently changed into another graph | Fail on format capacity overflow and missing component assignments; test each case |
| `vehicle` access tags were ignored | Motor routes could include explicitly restricted roads | Resolve recognised restrictions from motor_vehicle to vehicle to access; test bans and specific overrides |
| Malformed speed and geohash inputs were unchecked | Non-finite speeds could break graph builds; infinite precision or enormous corridor requests could hang | Reject malformed/non-finite speeds, invalid units/coordinates/precision, reversed boxes, and queries exceeding 100,000 cell iterations |
| Build emitted no JavaScript | A consumer needed an implicit TS loader | Emit ESM and declarations; test the package's public export using plain Node |
| Vulnerable test-tool dependency tree and no CI | Known development-tool advisories and unchecked regressions | Upgrade Vitest and resolved tools; add immutable-action CI with read-only permissions, tests, type checking, build/import checks, fixture regeneration, and dependency auditing |

## Local evidence

- Baseline: 84 TypeScript tests passed; four real-data tests skipped because `data/tiles` is absent. The documented historical 206-test total was not a fresh-clone result.
- After changes: **139 TypeScript tests and 152 Python tests passed**. The same four real-data tests remain skipped.
- `pnpm typecheck`, `pnpm build`, and `pnpm test:build` passed on Node 24.18.0. The import smoke test checks the built package against independently generated fixture costs.
- `pnpm audit --audit-level low`: no known vulnerabilities reported at review time. This covers the npm dependency tree, not Python packages or future advisories.
- All three Python fixture generators ran. Two ladder tile binaries changed because distinct parallel shapes are now retained; expected routing costs did not change.
- Hosted Linux/Node 22 and 24 checks are configured in CI; local results alone do not establish those platform results.
- No real PBF build, real-Delhi scale run, browser offline test, Android/BLE test, deployment, or field test was performed in this review. The fresh clone contains neither the production dataset nor an app. PyOsmium is not installed in the local Python environment.

## Release blockers, in order

1. **Choose and implement the actual travel profile.** `roads.py` builds a motor-road graph with vehicle speeds and one-way rules. It includes motorways and excludes footpaths, steps, pedestrian streets, and service roads. This cannot be presented as pedestrian evacuation guidance or walking ETA. Build an explicit walking profile with appropriate access/direction rules and useful entrances/exits before adding the primary escape flow. Existing decisions against casually adding turn restrictions remain in force; the motor model's ignored turn restrictions must remain a visible limitation.
2. **Bind every tile to one dataset generation.** Dense IDs are build-local. Owner collision checks catch some invalid combinations but cannot prove that tiles with non-overlapping ownership came from the same build. Add an integrity manifest with source provenance, tile format version, travel profile, generation ID, per-file sizes/hashes, and a verified distribution trust model. Install datasets atomically; keep the previous complete generation until verification succeeds. Clean stale output files between builds without destroying the active dataset.
3. **Exercise the real graph reproducibly.** Acquire/rebuild the documented Delhi extract, record its checksum and timestamp, run the 2,000-pair oracle harness, validate boundary consistency, and measure routing latency/memory on budget devices. The scale harness currently skips cost comparisons for queries that report missing tiles; add a complete contiguous test region and adversarial frontier cases. Historical performance figures are not measurements of this patch.
4. **Implement the offline application.** There is no tracked `apps/web` package. Needed: route worker, GPS/manual start, nearest-road snapping, edge-aware route reconstruction (parallel edges are ambiguous in a node-only path), IndexedDB generation storage, persistent-storage/quota/error handling, download progress, offline shell, and fully local map assets. Assert cold-start airplane-mode operation and storage-loss recovery before claiming offline readiness.
5. **Make route uncertainty visible.** Consumers must branch on `status`, handle `undefined` as unknown endpoint/unreachable in the supplied graph, and never label an incomplete result as optimal or a place as safe. A finite path under `budget-exceeded` is only an incumbent. `missing-tiles` requires load/retry or explicit incomplete coverage. The edge-cost callback must remain deterministic throughout a query. Tile buffers and exposed array views must remain immutable after ingestion validation.
6. **Build the hazard threat model and expiry behavior.** Sign/verify canonical reports, bound message and storage sizes, rate-limit receiving peers, handle clock skew/replay/expiry, expose report age and provenance, and allow dismissal. Keys do not establish independent witnesses. Local rerouting and a pure transport interface should precede network transport.
7. **Validate native transport on physical devices.** BLE background discovery, peripheral support, permissions, fragmentation, reconnection, power use, and screen-off behavior need at least two Android devices. The web build must not imply that it can form an automatic BLE mesh. Do not promise anonymity.
8. **Validate delivery and operation.** Mobile accessibility and stress flows, interrupted downloads, crash recovery, offline install/update/rollback, dataset refresh policy, OSM attribution/licensing, security reporting, and a device/OS acceptance matrix are still outstanding. There is no deployed app to assess for hosting headers or runtime behavior.

## API and build notes

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:build
python -m pip install -r packages/pipeline/requirements-dev.txt
python -m pytest packages/pipeline/tests
```

Node 22.12+ is required by the resolved build tooling. Build core before consuming `@offgrid/core`; exports now point to `dist`, including TypeScript declarations. Pipeline tests do not need OSM downloads or PyOsmium. Building production data still requires `packages/pipeline/requirements.txt` and the source extract.

Tile format remains version 2: binary layout did not change. Rebuild tiles to correct old parallel-road geometry and apply access parsing changes. Oversized data that used to be silently clipped now fails explicitly. Geohash precision is bounded to 1–12; split antimeridian corridor queries into two ordered boxes.

Reference checks: [OSM access hierarchy](https://wiki.openstreetmap.org/wiki/Key:access), [Vitest migration guidance](https://vitest.dev/guide/migration/), and the locally queried npm advisory database. These explain tag/tooling semantics; they do not validate local road legality or safety.
