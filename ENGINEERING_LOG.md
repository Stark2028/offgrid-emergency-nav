# Engineering Log

Decisions, bugs, and hard-won facts. Written so that anyone picking this up — a
different person, or a different AI assistant — can continue without
re-deriving conclusions or repeating mistakes that have already been made.

**Read this before changing routing, the tile format, or the mesh design.**

Companion documents:
- [TASKS.md](TASKS.md) — what is done and what is next
- [README.md](README.md) — what the project is

---

## Ground rules for anyone continuing this work

1. **The reference Dijkstra is the oracle.** If `bidirectional-astar.ts` and
   `dijkstra-reference.ts` disagree, the bidirectional router is wrong. Do not
   "fix" the oracle to make tests pass. It is deliberately simple so it can be
   audited by reading.

2. **Never claim a fix without running the tests.** Several routing fixes
   attempted so far were wrong — one was a regression that broke six passing
   tests. Run `pnpm --filter @offgrid/core test` before and after.

   Related: **instrument before theorising.** BUG-001 and BUG-009 each cost
   three wrong hypotheses. Both were solved in one pass once actual values were
   dumped — tile arrays for BUG-001, potential sums and settled counts for
   BUG-009. A plausible mechanism is not evidence.

3. **Compare costs, not paths.** Ties make the optimal path non-unique. Two
   correct implementations can legitimately return different node sequences of
   identical cost.

4. **Measured numbers only.** Every performance figure in the README must come
   from a benchmark that was actually run. The original project proposal
   asserted "<15ms routing" and "75% fewer nodes" — those were never measured
   and must not be repeated as fact.

5. **Do not add turn restrictions, contraction hierarchies, or messaging.**
   Each was considered and deliberately rejected or deferred; see below.

---

## Open bugs

None. All 206 tests pass (88 TypeScript, 118 Python).

## Fixed bugs

### BUG-001 — Router emitted unresolvable node ids in paths (FIXED)

**Root cause: OSM node ids exceed 2\*\*32, and the pipeline masked them to u32.**

Delhi's largest OSM node id is **14,162,787,060** — 3.3x past `2**32`. The
serialiser did `sorted(member_ids)` on true Python integers, then wrote each as
`struct.pack("<I", node_id & 0xFFFFFFFF)`. Truncation is:

- **not order-preserving** — the stored node table was therefore *not* ascending,
  while `format.ts` documented it as ascending and `Tile.findSlot` binary-searched
  on that guarantee. Measured: **all 40 sampled tiles violated it, and 4,380 of
  14,980 forward edge targets (29%) looked unresolvable** despite being present;
- **not injective** — distinct OSM nodes could collide onto one stored id.

So a "phantom" node id on a returned path was never foreign. It was a masked id
whose true owner sorted elsewhere, which `findSlot` then failed to locate.

**Fix.** Nodes are assigned **dense build-local indices** ordered by OSM id, so
ascending order is structural rather than a convention a later edit can break.
Arrays stay `u32` with no size cost. `TILE_VERSION` bumped to 2 (version 1 tiles
are unreadable and must be rebuilt), `dense_id_map()` is exposed so fixtures can
describe expectations in the runtime's id space, and the serialiser now asserts
strict ascendingness per tile.

**Verified.** `brokenPaths=0`, `unresolvableNodes=0`, and zero router-cheaper-
than-oracle cases across 301 sampled pairs. Graph output is byte-identical in
shape (246,466 nodes / 658,533 edges / 28.5 MB) — this was an encoding defect,
not a graph defect.

**Both earlier hypotheses in this log were wrong.** Neither halo participation
in a join nor `intern()` admitting foreign ids had anything to do with it. Three
sessions were spent on search-logic theories for what was a data-format bug. The
lesson is in the ground rules: instrument before theorising.

**Why fixtures never caught it.** Hand-built graphs use small sequential ids that
survive masking unchanged, so they are sorted either way. Only real OSM ids past
`2**32` expose it — which is the argument for the scale harness existing.

### BUG-009 — Backward search used the forward potential (FIXED)

**Root cause: `toKey` applied the same potential sign to both searches.**

The balanced scheme requires `p_f(v) + p_b(v) == 0` at every node. `toKey` took
no direction argument, so all three call sites — both initial pushes and the
in-loop relaxation — built keys with `+doublePotential(v)`. Instrumenting the
failing pair showed the actual sum was `2*dp(v)`: 5998, 5488, 5238, 4984, never
zero.

The backward search was therefore steered toward the *target* it started from
instead of toward the source. The termination bound compares frontier keys that
no longer mean what it assumes, so the search stopped believing it was finished
while a cheaper path was still open.

**Symptom.** Routes 0.03–4% longer than optimal in ~2% of pairs — always dearer,
never cheaper, paths always valid and walkable.

**Two measurements that pinned it, after three wrong theories:**

- `maxSettled: 1e7` changed nothing (514 settled either way). The search was not
  being cut short by a budget; it genuinely believed it was done. That killed the
  whole "stopped too early for want of effort" family.
- The router settled **514** nodes against the oracle's **1249**, diverging after
  12 shared nodes. Exploring *less* and committing to a wrong branch is the
  signature of a misdirected frontier, not a truncated one.

**Fix.** `SearchState` carries its own sign (`+1` forward, `-1` backward) and
`toKey` takes the state, so a key cannot be built without choosing a side. The
invariant is now structural rather than a convention spread across call sites.

**Measured benefit, now that it is correct.** On real Delhi tiles across 420
routable pairs: **A\* settles 872 nodes vs Dijkstra's 2501 — 65% fewer.** This is
the first honest benchmark of the bidirectional claim; it was not measurable
while the potential was wrong.

**Attempted and did NOT work.** Rewriting the potential in doubled integer units
to remove `Math.round` error, and replacing the `Math.max(0, …)` key clamp with
an assertion. The failing pair returned byte-identical numbers afterwards. Kept
anyway — the clamp really would destroy heap ordering if it fired, and the
assertion proves it does not — but it was not the fix.

### BUG-010 — A fixture test hardcoded node ids that the dense remap invalidated (FIXED)

`routing.test.ts`'s one-way test asserted `route(tiles, 1, 4).cost < route(tiles, 4, 1).cost`
using literals written when fixtures were keyed by OSM id. After BUG-001 those
labels addressed different nodes, so the inequality was asserting a premise that
no longer held — while the two adjacent assertions, which read expected costs
from the fixture, passed.

**The router was right and the test was wrong.** Worth stating because the
instinct on a red test is to suspect the code.

**Fix.** The test now derives asymmetric pairs from the fixture's own `shortest`
table and checks the router against the oracle in both directions for every one.
A literal node id in a test is now a smell: ids are dense build-local indices, so
a literal means whatever landed in that slot.

### BUG-002 — Router fabricated a zero-cost route (FIXED)

`route()` returned `{cost: 0, path: []}` whenever the search touched a tile that
was not loaded, even when it had found a complete valid path. `cost: 0` reads as
free travel to any caller.

**Fix.** A found path is returned regardless of `missing`; `missing` is advice
("a better route might exist through these cells"), never a reason to discard a
result. When genuinely no path exists, `cost` is `Infinity` and `path` is empty.

### BUG-003 — `resolve()` returned slot -1, laundering undefined past `!` (FIXED)

`TileSet.resolve()` returned `{tile, slot: -1, halo: false}` when the `owners`
map claimed a tile but `findSlot` could not locate the id in it. `components[-1]`
is `undefined`, and `component()`'s non-null assertion (`!`) pushed that straight
past the type system, so the documented "-1 when unknown" contract was silently
violated and the router's `>= 0` guard passed on garbage.

**Fix.** `resolve()` falls through to the halo scan when `findSlot` fails;
`component()` uses `?? -1` instead of `!`.

**Lesson.** `noUncheckedIndexedAccess` is on precisely to catch this, and a `!`
defeated it. Be suspicious of `!` on a typed-array index.

### BUG-004 — Restricting the `mu` join was a regression (REVERTED)

**What was tried.** Removing the in-loop `mu` update, joining only at settled
nodes, on the theory that tentative `candidate` values corrupt the stitch.

**Result.** Broke six previously-passing fixture tests (`detour`, `ladder` —
the two cases built around competing near-equal paths). Went from 85/88 to
79/88.

**Why it was wrong.** In bidirectional search the optimal path's meeting node is
frequently discovered *only* through the in-loop check; it may never be popped
by both sides before the termination bound fires. Deleting that check loses
those meetings entirely.

**Do not try this again.**

### BUG-005 — Explicit meeting predecessor changed nothing (NO-OP)

**What was tried.** Recording the predecessor that belongs to a mid-relaxation
join, and having `joinPaths` use it instead of the tree link.

**Result.** Compiled cleanly, all six regressions cleared, same three scale
failures. Harmless but did not address the cause. The code is still in place —
it is defensible on its own terms, but it is not the fix.

### BUG-006 — Fixture graphs collapsed under simplification (FIXED)

The first routing fixtures were built as chains and closed rings. Simplification
keeps a node only when it offers a routing *choice*, so a four-node detour
collapsed to a single parallel edge and a triangle collapsed into **self-loops**
(`3 -> 3`). The fixtures tested nothing.

**Fix.** Nodes that must survive get dead-end **stubs** to force degree 3. Dead
ends need *two* stubs, not one — a single stub turns a tip into a plain
through-node, which then collapses, making the anchor actively harmful.

The generator now **fails loudly (exit 1)** if a case loses its structure.

### BUG-007 — Simplification collapsed almost nothing (FIXED, pre-log)

Real-graph simplification achieved 11% instead of the expected ~64%: two-way
through-nodes saw the return edge as a second candidate. Cost tests passed
throughout — a graph that fails to simplify still has correct costs.

### BUG-008 — Every road's geometry stored twice (FIXED, pre-log)

0% geometry sharing measured across 200 tiles. Combined with BUG-007, fixing
both took tiles from 64 MB to 28.5 MB.

---

## Decisions that must not be silently reversed

### Integer edge weights, never floats
Weights are centiseconds of travel time in `Uint32Array`. Float accumulation
makes the forward and backward searches disagree about the cost of the same
path, so the meeting-point comparison picks a marginally wrong node — and the
fuzz test goes flaky in a way that looks like a logic error.

### Balanced potentials in bidirectional A\*
`p_f(v) = (h_f(v) − h_b(v))/2`, `p_b(v) = −p_f(v)`. Two independent heuristics
are each individually admissible but optimise *inconsistent* objectives. Costs
roughly half the heuristic strength of one-directional A\*; correct.

### μ-bound termination, not "frontiers met"
Stop when `topF + topB ≥ μ`. The first node both searches reach is usually not
on the optimal path.

### Hazards never get infinite weight — cap at ×20
An attacker generates keypairs in microseconds, so any "N distinct witnesses"
rule is trivially satisfiable. Infinite weight would let two free keypairs
hard-block any road mesh-wide — in a protest, a crowd-herding tool. A ×20
penalty reroutes just as effectively while bounding the blast radius.

### Hazards are advisory and user-visible, not invisible graph mutations
Show report count and age; allow dismiss. A user who sees *why* the route
changed can detect manipulation; one whose blue line silently moves cannot.
This is UX doing security work.

### Sorted ID lists for mesh reconciliation, not Bloom filters
At hundreds of hazards the full ID list is ~8 KB. A Bloom false positive means a
peer wrongly believes you have a hazard and never sends it — silent,
unrecoverable loss in a safety app, degrading worst under emergency load.

### No messaging, ever
Bridgefy was broken twice by academic cryptographers (Royal Holloway 2020;
USENIX Security '22 "Adopting libsignal is not enough"), and researchers advise
protesters not to rely on it. OffGrid carries hazard reports *about places*,
never communication between people. Narrower attack surface, less incriminating
data.

### Never claim anonymity
BLE advertising is a radio beacon and is trackable. Bridgefy's real failure was
being trusted because it was marketed as safe.

### No contraction hierarchies
Multi-week preprocessing for a graph plain bidirectional A\* solves in well under
100 ms. Impressive on paper, wrong here.

---

## Platform constraints (verified, do not re-litigate)

| Constraint | Consequence |
|---|---|
| **Web Bluetooth is central-only.** Browsers cannot advertise as BLE peripherals, on any engine, with none planned. | A PWA cannot form a mesh. Native (Capacitor) is required for the core feature. `@capacitor-community/bluetooth-le` is also central-only — use Capawesome or Cap-go. |
| **WebRTC-over-LAN needs shared Wi-Fi**, and public Wi-Fi commonly blocks the multicast that `.local` mDNS ICE candidates depend on (AP/client isolation). | Unreliable exactly where it is needed. Opportunistic only. |
| **QR exchange requires calm and cooperation.** | Works for a prepared group syncing *before* trouble. Not for strangers in a moving crowd under gas. |
| **Ed25519 in WebCrypto is Chrome 137+** (May 2025), not 113. Firefox 129+, Safari 17+. | Needs a `@noble/ed25519` fallback for budget Android. |
| **Safari evicts IndexedDB after ~7 days** of non-use. | Catastrophic for a rarely-opened emergency app. Drive PWA install hard; detect loss and re-download. |
| **A-GPS assistance data is network-fetched.** | Offline cold-start fixes take 30–90 s. Prefetch tiles around last-known position; allow a manual pin drop. |
| **Offline basemaps fail silently** if glyphs/sprites are not self-hosted — default style URLs point at remote CDNs. | Bundle all glyph ranges including Devanagari for Delhi street names. |

---

## Facts about the data (measured, not estimated)

- Source: Geofabrik India Northern Zone, 223 MB → cropped to 9.2 MB Delhi
  (173,679 ways / 793,412 nodes).
- Output: **246,466 nodes · 658,533 edges · 3,463 tiles · 28.5 MB**
  (8.2 KB mean, 64 KB max).
- **510 components**; the largest holds 99.4% of nodes.
- Geohash-6 cells are ~1.22 km × 0.61 km.
- **Max OSM node id: 14,162,787,060.** Well past `2**32` — node ids must never be
  stored in a u32 without a remap. See BUG-001.
- `highway=service` is excluded: 13.2% of ways, near-zero value for
  through-routing, ~20% of tile size.

**Note on the node count.** An early estimate said ~61k nodes. That measured a
narrower network over the 1,484 km² NCT; this covers ~2,600 km² including
Gurgaon and Noida, and 167k of the nodes are genuine three-way junctions. The
graph is correct — the estimate measured something else.

---

## Toolchain notes

- **pnpm** installed via `npm install -g pnpm` (corepack failed with EPERM on
  `C:\Program Files\nodejs`).
- **PyOsmium, not pyrosm.** pyrosm depends on `cykhash`, which has no Python
  3.12 Windows wheel and needs a C++ toolchain. Osmium suits us better anyway:
  it streams nodes and ways (constant memory) rather than returning
  GeoDataFrames we would immediately tear apart into flat arrays.
- **Geohash is hand-rolled in both languages** and pinned bit-for-bit by 206
  shared vectors. Tile keys cross the Python/TypeScript boundary; a mismatch
  would mean silently unreachable roads. Regenerate with
  `tools/gen_geohash_vectors.py`.
- Python venv at `packages/pipeline/.venv`; run tests with
  `./.venv/Scripts/python.exe -m pytest tests/`.

---

## Test inventory

| Suite | Count | Command |
|---|---|---|
| TypeScript (core) | 88 pass | `pnpm --filter @offgrid/core test` |
| Python (pipeline) | 118 pass | `cd packages/pipeline && ./.venv/Scripts/python.exe -m pytest tests/` |

All green, including the 2,000-pair scale fuzz against real Delhi tiles.

**Fixture generators** — rerun these if the graph format or simplification
changes:
- `tools/gen_geohash_vectors.py` — cross-language geohash agreement
- `tools/gen_tile_fixtures.py` — binary tile reader cases
- `tools/gen_routing_fixtures.py` — adversarial routing graphs, with expected
  costs from an *independent* Dijkstra so a shared bug cannot make both agree
