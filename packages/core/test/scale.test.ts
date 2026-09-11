import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Tile } from "../src/graph/tile.js";
import { TileSet } from "../src/graph/tileset.js";
import { dijkstra } from "../src/routing/dijkstra-reference.js";
import { route } from "../src/routing/bidirectional-astar.js";

/**
 * Scale verification against real Delhi tiles.
 *
 * The fixture tests in routing.test.ts pin correctness on adversarial
 * *structure* — one-ways, ties, forced bottlenecks — but every fixture is
 * around sixteen nodes. A router can be correct on sixteen nodes and wrong on
 * 246,466: heap capacity assumptions, the key offset, integer overflow in the
 * potential, and halo-node handling across tile boundaries only bite at scale.
 *
 * So this harness fuzzes random origin/destination pairs over real pipeline
 * output and diffs every one against the reference implementation.
 *
 * It is skipped when data/tiles is absent, so a fresh clone still passes:
 * the tiles are gitignored build output. Regenerate with
 * `packages/pipeline/build_graph.py`.
 */

const TILE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "data",
  "tiles",
);

const HAVE_TILES = existsSync(TILE_DIR);

/** Pairs to fuzz. Enough to be meaningful, quick enough for every test run. */
const FUZZ_PAIRS = 2_000;

/**
 * Tiles to load. The reference Dijkstra is deliberately unoptimised, so an
 * exhaustive search over all 246k nodes per pair would make this unusably slow.
 */
const TILE_BUDGET = 40;

/**
 * Load a spatially *contiguous* block, not the largest tiles by size.
 *
 * Size-ranked selection picks dense cells scattered across the city, so routes
 * constantly run off the edge of what is loaded and the harness mostly measures
 * missing tiles. Geohash strings sort into spatial locality — a shared prefix
 * means adjacent cells — so taking a consecutive run gives a connected region.
 * This is also how the app will prefetch a route corridor.
 */
function loadCentralTiles(): { tiles: TileSet; nodes: number[] } {
  const files = readdirSync(TILE_DIR)
    .filter((f) => f.endsWith(".bin"))
    .sort();

  // Anchor on the densest cell, then take its geohash neighbourhood.
  let anchor = files[0]!;
  let anchorSize = 0;
  for (const file of files) {
    const size = readFileSync(join(TILE_DIR, file)).byteLength;
    if (size > anchorSize) {
      anchorSize = size;
      anchor = file;
    }
  }

  const anchorIndex = files.indexOf(anchor);
  const start = Math.max(0, anchorIndex - Math.floor(TILE_BUDGET / 2));
  const block = files.slice(start, start + TILE_BUDGET);

  const tiles = new TileSet();
  for (const file of block) {
    const bytes = readFileSync(join(TILE_DIR, file));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    tiles.add(new Tile(buffer as ArrayBuffer));
  }

  // Collect non-halo nodes: halo stubs have no adjacency here, so routing
  // between them tests nothing but the missing-tile path.
  const nodes: number[] = [];
  for (const geohash of tiles.loaded) {
    const tile = tiles.get(geohash)!;
    for (let slot = 0; slot < tile.nodeCount; slot++) {
      if (!tile.isHalo(slot)) nodes.push(tile.globalIds[slot]!);
    }
  }

  return { tiles, nodes };
}

/** Deterministic PRNG so a failing pair is reproducible from the seed. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!HAVE_TILES)("real Delhi tiles", () => {
  const { tiles, nodes } = HAVE_TILES
    ? loadCentralTiles()
    : { tiles: new TileSet(), nodes: [] as number[] };

  it("loads a usable slice of the real graph", () => {
    expect(tiles.size).toBeGreaterThan(0);
    expect(nodes.length).toBeGreaterThan(1_000);
  });

  it(`matches reference Dijkstra over ${FUZZ_PAIRS} random pairs`, () => {
    const rng = makeRng(0x0ff6_71d);

    let routable = 0;
    let unreachable = 0;
    let offEdge = 0;
    let settledRouter = 0;
    let settledReference = 0;

    for (let i = 0; i < FUZZ_PAIRS; i++) {
      const from = nodes[Math.floor(rng() * nodes.length)]!;
      const to = nodes[Math.floor(rng() * nodes.length)]!;
      if (from === to) continue;

      const reference = dijkstra(tiles, from, to);
      const actual = route(tiles, from, to);

      if (reference === undefined) {
        // The router may still report tiles it wanted; what it must never do is
        // invent a route the oracle says does not exist.
        if (actual !== undefined) {
          expect(actual.path, `${from}->${to}: oracle found no route`).toEqual([]);
        }
        unreachable++;
        continue;
      }

      expect(actual, `${from}->${to} should be routable`).toBeDefined();

      // The router explores toward the target and can reach the edge of the
      // loaded block; the oracle sweeps outward and silently ignores halo nodes
      // with no adjacency. When the router says it wanted tiles we did not
      // load, the two are not solving the same problem — skip rather than
      // assert a mismatch that is an artefact of the harness.
      if (actual!.missing.length > 0) {
        offEdge++;
        continue;
      }

      expect(actual!.cost, `${from}->${to} cost mismatch`).toBe(reference.cost);

      routable++;
      settledRouter += actual!.settled;
      settledReference += reference.settled;
    }

    // A harness that never found a route would pass every assertion above.
    expect(routable, "no routable pairs — the harness proved nothing").toBeGreaterThan(100);

    console.log(
      `  routable ${routable}, unreachable ${unreachable}, off-edge ${offEdge}, ` +
        `mean settled: A* ${Math.round(settledRouter / routable)} vs ` +
        `Dijkstra ${Math.round(settledReference / routable)}`,
    );
  });

  it("explores less of the graph than exhaustive search", () => {
    // On sixteen-node fixtures this is nearly vacuous. At this scale it is the
    // actual claim bidirectional A* makes.
    const rng = makeRng(0xbeef);
    let router = 0;
    let reference = 0;
    let pairs = 0;

    for (let i = 0; i < 200 && pairs < 50; i++) {
      const from = nodes[Math.floor(rng() * nodes.length)]!;
      const to = nodes[Math.floor(rng() * nodes.length)]!;
      if (from === to) continue;

      const oracle = dijkstra(tiles, from, to);
      if (!oracle) continue;
      const actual = route(tiles, from, to)!;
      if (actual.missing.length > 0) continue; // ran off the loaded block

      router += actual.settled;
      reference += oracle.settled;
      pairs++;
    }

    expect(pairs, "found no routable pairs to compare").toBeGreaterThan(10);
    expect(router).toBeLessThan(reference);
  });

  it("returns paths whose weights sum to the reported cost", () => {
    const rng = makeRng(0xc0ffee);
    let checked = 0;

    for (let i = 0; i < 300 && checked < 50; i++) {
      const from = nodes[Math.floor(rng() * nodes.length)]!;
      const to = nodes[Math.floor(rng() * nodes.length)]!;
      if (from === to) continue;

      const result = route(tiles, from, to);
      if (!result || result.path.length === 0) continue;
      if (result.missing.length > 0) continue; // ran off the loaded block

      expect(result.path[0]).toBe(from);
      expect(result.path[result.path.length - 1]).toBe(to);

      let sum = 0;
      for (let j = 0; j + 1 < result.path.length; j++) {
        const a = result.path[j]!;
        const b = result.path[j + 1]!;
        let best = Number.POSITIVE_INFINITY;
        for (const edge of tiles.edges(a, "forward")) {
          if (edge.target === b) best = Math.min(best, edge.weight);
        }
        expect(best, `${from}->${to}: no edge ${a}->${b}`).toBeLessThan(Number.POSITIVE_INFINITY);
        sum += best;
      }
      expect(sum, `${from}->${to}: path weight != reported cost`).toBe(result.cost);
      checked++;
    }

    expect(checked, "validated no paths").toBeGreaterThan(10);
  });
});
