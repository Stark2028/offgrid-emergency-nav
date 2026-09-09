# OffGrid

**Offline-first emergency navigation. No servers, no internet, no cell towers.**

During internet blackouts, natural disasters, or mass protests, cellular networks are jammed or severed and centralised navigation fails — Google Maps needs a server roundtrip to compute a route, and has no way to tell civilians about barricades, blocked roads, or hazards on the ground.

OffGrid computes routes entirely on-device from a local road graph, and shares hazard reports between nearby devices with no infrastructure at all.

> **Status: in development.** Week 1 of a 6-week build. The graph and routing core is being built first, verified against a reference implementation, before any UI exists.

---

## How it works

| | |
|---|---|
| **Routing** | Bidirectional A\* over a CSR-encoded road graph in flat typed arrays, running in a Web Worker |
| **Map data** | Real OpenStreetMap data for Delhi NCT — ~61k nodes / ~209k edges after topological simplification, ~15 MB of binary tiles |
| **Storage** | Geohash-6 tiles in IndexedDB; the ~9 tiles around your GPS fix load in ~60 KB so the first paint is instant |
| **Basemap** | Protomaps PMTiles, self-hosted glyphs and sprites, rendered offline by MapLibre |
| **Hazards** | Ed25519-signed reports with graduated trust, shared peer-to-peer |
| **Backend** | None. Static files on a CDN — a tool built for infrastructure failure shouldn't depend on infrastructure |

## Engineering notes

A few decisions that go against the obvious approach, and why.

**Integer edge weights, not floats.** Weights are centiseconds of travel time in a `Uint32Array`. With float weights, accumulated rounding makes the forward and backward searches disagree about the cost of the same path, so the meeting-point comparison picks a marginally wrong node — a bug that surfaces as a flaky test rather than an obvious failure.

**Balanced potentials in bidirectional A\*.** Running two independent heuristics makes the searches optimise inconsistent objectives, and terminating when the frontiers first meet returns a suboptimal path. The forward and backward potentials are balanced so they sum to zero, and the search terminates on `topF + topB ≥ μ`, where `μ` is the best path cost found so far.

**Hazards never get infinite weight.** An attacker can generate keypairs in microseconds, so any "N distinct witnesses" rule is trivially satisfiable. Confirmed hazards are capped at a ×20 penalty — which reroutes just as effectively while bounding the blast radius of a false report. Hazards are shown to the user as dismissible annotations with their age and report count, not applied as invisible graph mutations.

**Sorted ID lists, not Bloom filters, for peer reconciliation.** At a few hundred hazards the complete ID list is ~8 KB. A Bloom false positive means a peer wrongly believes you already have a hazard and never sends it — silent, unrecoverable data loss, degrading worst under emergency load. Exact reconciliation is simpler and cheaper than the failure mode it avoids.

**Peer-to-peer is QR-first.** Browsers are BLE *central*-only and cannot advertise as peripherals, so a PWA cannot form a true BLE mesh. WebRTC-over-LAN needs shared Wi-Fi, which public networks often break with AP isolation and which usually doesn't exist during a blackout. QR bundle exchange — display a signed hazard bundle, scan it on another phone — needs no network, no pairing, and no radio, so it works exactly where the alternatives fail. The transport layer is an interface; native BLE drops in later without touching the mesh logic.

## Repository layout

```
packages/core/       Graph, routing, mesh, crypto. Pure TypeScript, zero DOM
                     dependencies — runs and tests in Node. Correctness lives here.
packages/pipeline/   Python. OpenStreetMap PBF -> binary geohash tiles. Build-time only.
apps/web/            React + TypeScript + Vite PWA.
```

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm test          # unit + fuzz tests
pnpm typecheck
```

Routing correctness is verified by fuzzing thousands of random origin/destination pairs against a reference Dijkstra implementation and asserting exact cost equality. Subtly-wrong routes are invisible without an oracle.

## License

MIT
