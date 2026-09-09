# OffGrid — Task List

End-to-end plan, from scaffold to deployed product. Reflects the state of the repo, not the original proposal — several items changed once real data and real browser constraints got involved.

**Status:** Week 1 complete. 165 tests passing (47 TypeScript, 118 Python). 7 commits.

Legend: `[x]` done · `[ ]` not started · `[~]` partially done

---

## Phase 0 — De-risking spikes

Two questions that can kill the project. Answer before building on top of them.

- [ ] **Spike A — mesh reality check.** Two physical Android phones, plain WebRTC DataChannel, over (i) home Wi-Fi, (ii) public hotspot with AP isolation, (iii) cellular with no shared network. Measure what actually connects.
  *Gate: decides how much WebRTC effort is justified versus going all-in on QR exchange. Expectation is (ii) and (iii) both fail.*
- [ ] **Spike B — offline basemap.** One MapLibre page, PMTiles archive, fully self-hosted style + glyphs + sprites, device in airplane mode, Delhi rendering with **Devanagari labels visible**.
  *This is the classic offline-map trap: default style URLs point at remote CDNs and fail silently.*

> Deferred deliberately — both need physical devices. Neither blocks the routing core, which is why Week 1 ran first. **Do these before Week 3.**

---

## Phase 1 — Pipeline and graph core ✅

### Repo and tooling
- [x] pnpm workspace (`packages/core`, `packages/pipeline`, `apps/web`)
- [x] Strict TypeScript — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- [x] Python venv, pinned requirements
- [x] `.gitignore` / `.gitattributes` (LF normalisation, binaries, generated files)
- [x] Public GitHub repo, pushed
- [ ] **`packages/core/src/index.ts`** — `package.json` `main` points at a file that does not exist. Harmless today (tests import deep paths) but breaks the moment `apps/web` imports `@offgrid/core`
- [ ] CI — GitHub Actions running both test suites on push
- [ ] Linting — ESLint + Prettier (TS), ruff (Python)

### OSM pipeline
- [x] `roads.py` — classification, speeds, access rules, oneway parsing
  - [x] Speed table bounded by `MAX_SPEED_KPH`, mirrored in `distance.ts` (heuristic admissibility depends on it)
  - [x] Exhaustive oneway handling incl. `oneway=-1`, implicit roundabout/motorway rules
  - [x] `highway=service` excluded — 13.2% of ways, near-zero value for through-routing
- [x] `crop_extract.py` — 223 MB Northern Zone → 9.2 MB Delhi (173,679 ways / 793,412 nodes)
  - [x] Avoids osmium's location cache (would index ~20M nodes, ~650 MB resident)
  - [x] Boundary-crossing ways kept whole, not clipped into dead ends
- [x] `graph.py` — way ingestion, simplification, component labelling
  - [x] Chain collapse preserving cost and direction
  - [x] Isolated rings survive (roundabout with no junction has no walk anchor)
  - [x] Missing coordinates fragment a way rather than drawing a line across the gap
  - [x] Weakly-connected components, largest first
- [x] `tiles.py` — geohash-6 binary CSR serialisation
  - [x] Forward **and** reverse adjacency materialised
  - [x] Global node ids, ascending (binary-searchable)
  - [x] Boundary edges duplicated into both tiles
  - [x] Halo nodes: coordinates, no adjacency
  - [x] Geometry interned and shared between an edge and its reverse
- [x] `build_graph.py` — orchestration + manifest
- [ ] **Pipeline validation pass** — assert no dangling halo refs, every boundary edge present in both adjacent tiles, spot-check known Delhi one-ways against reality
- [ ] Turn restrictions (`no_left_turn` etc.) — currently ignored; routes may suggest illegal turns

### Core primitives (TypeScript)
- [x] `geohash.ts` — encode / bounds / neighbours / `geohashesInBounds` (corridor prefetch)
  - [x] Pinned bit-for-bit against Python via 206 shared vectors
- [x] `distance.ts` — haversine + admissible heuristic
- [x] `format.ts` — binary layout contract
- [x] `heap.ts` — typed-array min-heap with decrease-key
- [x] `tile.ts` — zero-copy typed-array views over a tile buffer
- [x] `tileset.ts` — spans loaded tiles, resolves global ids, reports unresolved halo cells
- [ ] Spatial index (KD-tree / QuadTree) for nearest-road snapping from a GPS fix

### Verified output
- [x] 246,466 nodes · 658,533 edges · 3,463 tiles · 28.5 MB · 8.2 KB mean, 64 KB max
- [x] 510 components, largest holds 99.4% of nodes
- [x] Cross-language round-trip verified on real pipeline bytes

**Bugs found by building the real graph:**
- [x] Simplification collapsed almost nothing (11% vs 64%) — two-way through-nodes saw the return edge as a second candidate. Cost tests passed throughout; a graph that fails to simplify still has correct costs
- [x] Every road's geometry stored twice (0% sharing measured across 200 tiles)
- [x] Net effect: 64 MB → 28.5 MB

---

## Phase 2 — Routing correctness

The phase where correctness is actually proven. Nothing downstream matters if this is wrong.

- [ ] `dijkstra-reference.ts` — deliberately simple, no optimisations. The oracle.
- [ ] `bidirectional-astar.ts`
  - [ ] **Balanced potentials** — `p_f(v) = (h_f(v) − h_b(v))/2`, `p_b(v) = −p_f(v)`. Two independent heuristics optimise inconsistent objectives and break the termination bound
  - [ ] **μ-bound termination** — track best-so-far `μ`; stop when `topF + topB ≥ μ`. "Frontiers met" is wrong and returns suboptimal paths
  - [ ] Backward search over the reverse CSR
  - [ ] O(1) unreachability via component ids
  - [ ] Halo-node suspend/resume for demand-driven tile loading
- [ ] **10,000-pair fuzz harness** asserting bidirectional A\* cost == Dijkstra cost exactly (compare costs, not paths — ties make paths non-unique)
- [ ] Corridor prefetch — load cells intersecting the source→target corridor before searching
- [ ] Path reconstruction: node sequence → polyline with interior geometry
- [ ] Benchmarks on real Delhi data — route time, tile-load latency, nodes expanded, memory
  *Every performance number in the README must be measured, not asserted*
- [ ] Node CLI demo: route across Delhi from binary tiles, print the polyline

---

## Phase 3 — The app becomes real

End of this phase: a genuinely useful product with no mesh at all. **This is the safety net — protect it.**

- [ ] `apps/web` scaffold — Vite + React + TS + Tailwind (currently an empty `src/` with no `package.json`)
- [ ] IndexedDB tile store with LRU eviction
- [ ] Routing in a Web Worker, transferable buffers
- [ ] MapLibre + PMTiles offline basemap (productionises Spike B)
  - [ ] Self-hosted style JSON, **all** glyph ranges incl. Devanagari, sprites at 1× and 2×
- [ ] PMTiles extract for Delhi (`pmtiles extract`, z14) — verify exact CLI flags via `--help`
- [ ] GPS position + nearest-road snapping
- [ ] Destination selection (tap / search)
- [ ] Route rendering
- [ ] PWA shell — manifest, service worker, install prompt
- [ ] `navigator.storage.persist()` + quota handling
- [ ] First-run asset download with progress
- [ ] Graceful degradation — route-only mode when the basemap won't fit
- [ ] **Demo: airplane-mode phone, real GPS, tap destination, route drawn on an offline map**

---

## Phase 4 — Hazards, local only

- [ ] Ed25519 identity via WebCrypto
  - [ ] **`@noble/ed25519` fallback** — native support is Chrome **137+** (May 2025), not 113. Matters for budget Android
  - [ ] Persistent keypair
- [ ] Hazard model — type, location, timestamp, signature, TTL
- [ ] Signature verification
- [ ] Graduated trust: 1 witness = ×5 (amber dashed), ≥2 in 15 min = ×20 (red solid)
  - [ ] **Never ∞.** Two free keypairs would otherwise hard-block any road mesh-wide — a crowd-herding tool in a protest
- [ ] Hazard expiry and local persistence
- [ ] Dynamic edge-weight overlay + reroute on change
- [ ] Report UI
- [ ] **Advisory annotations, not invisible graph mutations** — show report count and age, allow dismiss. A user who sees *why* the route changed can detect manipulation
- [ ] Demo: report a hazard, watch the route change, dismiss it

---

## Phase 5 — Mesh

Scope set by the Phase 0 Spike A verdict.

- [ ] `MeshTransport` interface
- [ ] `LoopbackTransport` (tests)
- [ ] `BroadcastChannelTransport` (tabs — demo and testing, not a field transport)
- [ ] **`QRTransport`** — signed hazard bundle as a QR, scanned by another phone. No network, no pairing, no radio. **The primary field transport**
  - [ ] Bundle encoding + compression to fit a scannable QR
  - [ ] Camera scanning
- [ ] `WebRTCTransport` — LAN-opportunistic, QWBP-compressed QR signalling (~60 B vs ~2500 B SDP)
- [ ] Gossip protocol
  - [ ] **Sorted ID list reconciliation, not Bloom filters.** ~8 KB for hundreds of hazards; a Bloom false positive silently drops a hazard forever, degrading worst under emergency load
  - [ ] TTL hop limit
  - [ ] Time-bounded seen-ID cache
  - [ ] Receiver-enforced rate limits (per key, per geohash cell)
  - [ ] Hop-count trust weighting — physical proximity is the only scarce resource in the threat model
- [ ] Demo: two phones, hazard shared by QR, both reroute

---

## Phase 6 — Hardening and honesty

- [ ] Device matrix testing (Android versions, budget hardware, iOS)
- [ ] **Storage eviction** — Safari drops IndexedDB after ~7 days of non-use. Catastrophic for a rarely-opened emergency app; drive PWA install hard and detect loss
- [ ] **Cold-start GPS** — A-GPS assistance data is network-fetched, so offline fixes take 30–90 s. Prefetch tiles around last-known position; allow a manually dropped start pin
- [ ] Degraded modes: no GPS, no storage, no basemap
- [ ] In-app communication of limitations — never present a stale hazard set as current
- [ ] Accessibility pass (contrast, touch targets, screen reader) — this is a safety app used under stress
- [ ] Error boundaries and crash recovery
- [ ] Deploy to CDN (Cloudflare Pages / Netlify)
- [ ] Buffer for Phase 2–3 overruns

---

## Phase 7 — Stretch: native BLE

Only if Phases 1–6 land clean.

- [ ] Capacitor Android wrapper
- [ ] `BLETransport` — native advertise + scan, the one transport browsers cannot provide
- [ ] BLE MTU chunking and reassembly
- [ ] Android 12+ permission handling
- [ ] APK distribution

---

## Portfolio deliverables

- [ ] README with **measured** numbers and architecture diagrams
- [ ] Architecture decision record — the interesting calls: Web Bluetooth's central-only limitation, exact-vs-probabilistic reconciliation, capped hazard penalties, integer weights
- [ ] Demo video / GIF
- [ ] Live deployed URL
- [ ] 90-second interview demo script (rewrite the proposal's version around what actually got built)

---

## Known gaps and deferred decisions

| Item | Status |
|---|---|
| `packages/core/src/index.ts` missing | `main` points at a nonexistent file — fix before `apps/web` imports core |
| `apps/web` is an empty stub | No `package.json`; workspace resolves 2 projects, not 3 |
| Turn restrictions ignored | Routes may suggest illegal turns |
| Tile compression | 28.5 MB uncompressed; gzip/brotli would likely halve it. Deferred until real-device storage testing |
| No CI | Tests only run locally |
| No linting | No ESLint/Prettier/ruff |
| iOS is a hard target | No Web Bluetooth ever; aggressive storage eviction |
| Graph is 246k nodes, not the planned ~61k | Not a defect — we cover ~2,600 km² incl. Gurgaon/Noida vs the 1,484 km² NCT, and 167k are genuine 3-way junctions. The estimate measured a narrower network |
