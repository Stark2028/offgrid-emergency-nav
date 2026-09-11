# OffGrid — Task List

End-to-end plan, from scaffold to deployed product. Reflects the state of the repo, not the original proposal — several items changed once real data and real browser constraints got involved.

**Status:** Phase 1 complete, Phase 2 mostly complete. **204 of 206 tests passing** (86/88 TypeScript, 118/118 Python). All 47 routing fixture tests are green. The 2 remaining failures are BUG-009 — see [ENGINEERING_LOG.md](ENGINEERING_LOG.md).

> **Continuing this work (human or AI)?** Read [ENGINEERING_LOG.md](ENGINEERING_LOG.md) first. It records which fixes were wrong and why, so the same dead ends are not re-explored.

Legend: `[x]` done · `[ ]` not started · `[~]` partially done

---

## Phase 0 — De-risking spikes

Two questions that can kill the project. Answer before building on top of them.

- [ ] **Spike A — automatic BLE discovery.** Two physical Android phones running a Capacitor build with a peripheral-capable BLE plugin (Capawesome or Cap-go — `@capacitor-community/bluetooth-le` is central-only). Do they advertise, discover each other, and exchange a payload with **zero user interaction**, in a pocket, while moving?
  *This is the question that decides the product. Every app that actually worked in a protest — Bridgefy, Briar, Bitchat — is native with automatic BLE. No browser can advertise.*
- [ ] **Spike B — offline basemap.** One MapLibre page, PMTiles archive, fully self-hosted style + glyphs + sprites, device in airplane mode, Delhi rendering with **Devanagari labels visible**.
  *This is the classic offline-map trap: default style URLs point at remote CDNs and fail silently.*

> Both need physical Android devices. Neither blocks Phase 2 (pure Node), which is why the router runs first. **Spike B before Phase 3; Spike A before Phase 5.**

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
- [ ] **Safety layer** — extract metro stations, hospitals, open ground and arterial exits from OSM; flag them in the tile format. *Do this while the pipeline is already open: adding it later means reprocessing every tile*
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

- [x] `dijkstra-reference.ts` — deliberately simple, no optimisations. The oracle. Also `dijkstraFrom` for multi-target
- [x] `bidirectional-astar.ts`
  - [x] **Balanced potentials** — `p_f(v) = (h_f(v) − h_b(v))/2`, `p_b(v) = −p_f(v)`
  - [x] **μ-bound termination** — stop when `topF + topB ≥ μ`
  - [x] Backward search over the reverse CSR
  - [x] O(1) unreachability via component ids
  - [ ] Halo-node suspend/resume for demand-driven tile loading — currently reports `missing` cells for the caller to load and retry, rather than suspending mid-search
- [x] Adversarial fixture suite — 6 graphs (grid, detour, asymmetric, ladder, bottleneck, escape) with expected costs from an *independent* Dijkstra. **47 tests, all green**
- [~] **Scale fuzz harness** — 2,000 random pairs over real Delhi tiles, diffed against the oracle. Found BUG-001 (fixed) and BUG-009 (open). **2 failures: BUG-009**
- [x] `packages/core/src/index.ts` — the barrel `package.json` already pointed at
- [ ] Corridor prefetch — load cells intersecting the source→target corridor before searching
- [~] **Multi-target search for "get me out".** `dijkstraFrom` seeds every safe node at cost 0 over the reverse graph, so each node learns its cost to the *nearest* exit in one sweep. Tested (4 tests) against the `escape` fixture. Still needs: a bidirectional/A\* variant for speed, and real safe-exit data from the pipeline
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
- [ ] **"GET ME OUT" — the primary flow.** One thumb-sized button, no search field, no menu. Routes away from hazards to the nearest safe exit. Shows a thick line, a distance, and a *place name* ("Rajiv Chowk Metro, 600 m") — a name is something a human can carry when the phone dies
- [ ] Destination routing — secondary, for when the user does know where they are going
- [ ] Route rendering
- [ ] Cold-start GPS handling — last-known position, "finding you" state, manual pin drop
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

Transports in strict priority order. **BLE is the product**; everything else is a fallback for when it is unavailable.

- [ ] `MeshTransport` interface — the abstraction that makes BLE one implementation rather than a rewrite
- [ ] **`BLETransport` (Capacitor, Android) — the primary field transport.** Automatic advertise + scan, zero user interaction: two phones in pockets, three metres apart, sync silently. The only model that survives a moving crowd
  - [ ] Peripheral-capable plugin (Capawesome / Cap-go)
  - [ ] MTU chunking and reassembly (~20 B per packet — why the digest design matters)
  - [ ] Android 12+ permission handling (BLUETOOTH_SCAN / ADVERTISE / CONNECT)
- [ ] `QRTransport` — **scoped honestly**: a prepared group syncing *before* things get bad, not strangers exchanging codes under gas
- [ ] `WebRTCTransport` — opportunistic, only when a LAN exists
- [ ] `BroadcastChannelTransport` (tabs — demo and testing, not a field transport)
- [ ] `LoopbackTransport` (tests)
- [ ] Gossip protocol
  - [ ] **Sorted ID list reconciliation, not Bloom filters.** ~8 KB for hundreds of hazards; a Bloom false positive silently drops a hazard forever, degrading worst under emergency load
  - [ ] TTL hop limit
  - [ ] Time-bounded seen-ID cache
  - [ ] Receiver-enforced rate limits (per key, per geohash cell)
  - [ ] Hop-count trust weighting — physical proximity is the only scarce resource in the threat model
- [ ] **Explicitly out of scope: messaging.** Bridgefy was broken twice by academic cryptographers, including after adopting the Signal protocol; researchers advise protesters not to rely on it. OffGrid carries hazard reports *about places*, never communication between people — a far narrower attack surface and far less incriminating data
- [ ] No identity, no accounts, no contact list. Ephemeral rotating keys: enough for "two independent reports", not enough for "who"
- [ ] **Never claim anonymity.** BLE advertising is a radio beacon and is trackable. Bridgefy's real failure was being trusted because it was marketed as safe
- [ ] Demo: two phones in pockets, hazard reported on one, both reroute with no interaction

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

## Phase 7 — Dual-target packaging

The same codebase ships twice. Not a compromise — two genuinely different products.

- [ ] **Web build** — instant access, no install, full offline routing, no mesh. What a recruiter clicks; what someone with no signal uses
- [ ] **Android build (Capacitor)** — everything, including the BLE mesh
- [ ] APK signing key + distribution
- [ ] Verify the transport interface really does isolate the difference — web gets BroadcastChannel/WebRTC/QR, Android adds BLE, one codebase

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
| **BUG-009: occasional suboptimal route** | 2 scale tests fail. Paths are valid and walkable but 0.03–4% longer than optimal in ~2% of pairs (6 of 301 sampled). Always dearer, never cheaper ⇒ premature termination. See [ENGINEERING_LOG.md](ENGINEERING_LOG.md) |
| ~~BUG-001: unresolvable node ids~~ | **Fixed.** OSM ids exceed 2³²; masking them to u32 broke both sort order and uniqueness. Now dense build-local ids, `TILE_VERSION` 2 |
| `apps/web` is an empty stub | No `package.json`; workspace resolves 2 projects, not 3 |
| Turn restrictions ignored | Routes may suggest illegal turns |
| Tile compression | 28.5 MB uncompressed; gzip/brotli would likely halve it. Deferred until real-device storage testing |
| No CI | Tests only run locally |
| No linting | No ESLint/Prettier/ruff |
| iOS is a hard target | No Web Bluetooth ever; aggressive storage eviction |
| Graph is 246k nodes, not the planned ~61k | Not a defect — we cover ~2,600 km² incl. Gurgaon/Noida vs the 1,484 km² NCT, and 167k are genuine 3-way junctions. The estimate measured a narrower network |
