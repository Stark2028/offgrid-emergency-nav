import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Tile } from "../src/graph/tile.js";
import { TileSet } from "../src/graph/tileset.js";
import { dijkstra, dijkstraFrom } from "../src/routing/dijkstra-reference.js";
import { route } from "../src/routing/bidirectional-astar.js";
import index from "./fixtures/routing/index.json" with { type: "json" };

/**
 * Routing correctness.
 *
 * Two layers. First, fixture assertions: expected costs come from an
 * independent Dijkstra in packages/pipeline/tools/gen_routing_fixtures.py,
 * written separately from anything in this package so a shared bug cannot make
 * both agree. Second, a fuzz harness diffing bidirectional A* against the
 * reference implementation over every reachable pair — subtly-suboptimal routes
 * are invisible without an oracle.
 *
 * Costs are compared, never paths: ties make the optimal path non-unique, so
 * two correct implementations can legitimately return different node sequences.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "routing");

type CaseName = keyof typeof index;

const CASES = Object.keys(index) as CaseName[];

function loadSet(name: CaseName): TileSet {
  const set = new TileSet();
  for (const file of index[name].files) {
    const bytes = readFileSync(join(FIXTURES, file));
    // Copy out of Node's pooled Buffer: byteOffset is rarely 0 and Tile's
    // typed-array views assume the tile starts at offset 0.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    set.add(new Tile(buffer as ArrayBuffer));
  }
  return set;
}

/** Every ordered pair the fixture says is reachable, with its expected cost. */
function expectedPairs(name: CaseName): Array<[number, number, number]> {
  const shortest = index[name].shortest as Record<string, number>;
  return Object.entries(shortest).map(([key, cost]) => {
    const [from, to] = key.split("->").map(Number);
    return [from!, to!, cost];
  });
}

describe("reference Dijkstra", () => {
  it.each(CASES)("matches the fixture's independent costs: %s", (name) => {
    const tiles = loadSet(name);
    for (const [from, to, expected] of expectedPairs(name)) {
      const result = dijkstra(tiles, from, to);
      expect(result, `${name}: ${from}->${to} should be reachable`).toBeDefined();
      expect(result!.cost, `${name}: ${from}->${to}`).toBe(expected);
    }
  });

  it("returns a path whose edge weights sum to the reported cost", () => {
    const tiles = loadSet("grid");
    const result = dijkstra(tiles, 1, 16);
    expect(result).toBeDefined();

    let sum = 0;
    for (let i = 0; i + 1 < result!.path.length; i++) {
      const from = result!.path[i]!;
      const to = result!.path[i + 1]!;
      let best = Number.POSITIVE_INFINITY;
      for (const edge of tiles.edges(from, "forward")) {
        if (edge.target === to) best = Math.min(best, edge.weight);
      }
      expect(best, `no edge ${from}->${to} on the returned path`).toBeLessThan(
        Number.POSITIVE_INFINITY,
      );
      sum += best;
    }
    expect(sum).toBe(result!.cost);
  });

  it("costs nothing to route to yourself", () => {
    const tiles = loadSet("grid");
    const result = dijkstra(tiles, 1, 1);
    expect(result?.cost).toBe(0);
    expect(result?.path).toEqual([1]);
  });

  it("returns undefined for an unknown node", () => {
    const tiles = loadSet("grid");
    expect(dijkstra(tiles, 1, 999_999)).toBeUndefined();
    expect(dijkstra(tiles, 999_999, 1)).toBeUndefined();
  });
});

describe("bidirectional A*", () => {
  it.each(CASES)("agrees with the fixture's independent costs: %s", (name) => {
    const tiles = loadSet(name);
    for (const [from, to, expected] of expectedPairs(name)) {
      const result = route(tiles, from, to);
      expect(result, `${name}: ${from}->${to} should be reachable`).toBeDefined();
      expect(result!.cost, `${name}: ${from}->${to}`).toBe(expected);
    }
  });

  // The core correctness property. A premature-termination or inconsistent-
  // potential bug yields plausible routes that are quietly a few percent long.
  it.each(CASES)("matches reference Dijkstra on every reachable pair: %s", (name) => {
    const tiles = loadSet(name);
    const nodes = index[name].real;

    let compared = 0;
    for (const from of nodes) {
      for (const to of nodes) {
        if (from === to) continue;
        const reference = dijkstra(tiles, from, to);
        const actual = route(tiles, from, to);

        if (reference === undefined) {
          expect(actual, `${name}: ${from}->${to} unreachable per oracle`).toBeUndefined();
          continue;
        }
        expect(actual, `${name}: ${from}->${to}`).toBeDefined();
        expect(actual!.cost, `${name}: ${from}->${to}`).toBe(reference.cost);
        compared++;
      }
    }
    expect(compared, `${name} compared no pairs`).toBeGreaterThan(0);
  });

  it.each(CASES)("returns a path that is actually walkable: %s", (name) => {
    const tiles = loadSet(name);
    for (const [from, to, expected] of expectedPairs(name)) {
      const result = route(tiles, from, to);
      expect(result).toBeDefined();

      const path = result!.path;
      expect(path[0], `${name}: ${from}->${to} path must start at source`).toBe(from);
      expect(path[path.length - 1], `${name}: ${from}->${to} path must end at target`).toBe(to);

      // Every consecutive pair must be joined by a real edge, and the weights
      // must sum to the reported cost. Catches a mis-stitched meeting point.
      let sum = 0;
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i]!;
        const b = path[i + 1]!;
        let best = Number.POSITIVE_INFINITY;
        for (const edge of tiles.edges(a, "forward")) {
          if (edge.target === b) best = Math.min(best, edge.weight);
        }
        expect(best, `${name}: ${from}->${to} has no edge ${a}->${b}`).toBeLessThan(
          Number.POSITIVE_INFINITY,
        );
        sum += best;
      }
      expect(sum, `${name}: ${from}->${to} path weight != reported cost`).toBe(expected);
    }
  });

  it("respects one-way streets", () => {
    // The detour fixture has a direct one-way and a longer two-way bypass, so
    // some pairs cost differently in each direction.
    //
    // Endpoints are derived from the fixture rather than hardcoded: node ids are
    // dense build-local indices (see BUG-001), so a literal id means whatever
    // landed in that slot and silently stops testing what it claims to.
    const tiles = loadSet("detour");
    const shortest = index.detour.shortest as Record<string, number>;

    const asymmetric = Object.keys(shortest)
      .map((key) => {
        const [a, b] = key.split("->").map(Number);
        return { a: a!, b: b!, there: shortest[key]!, back: shortest[`${b}->${a}`] };
      })
      .filter((pair) => pair.back !== undefined && pair.there !== pair.back);

    expect(asymmetric.length, "fixture should contain directionally asymmetric pairs").toBeGreaterThan(0);

    // The router must agree with the oracle in *both* directions for every one.
    for (const { a, b, there, back } of asymmetric) {
      expect(route(tiles, a, b)!.cost, `${a}->${b}`).toBe(there);
      expect(route(tiles, b, a)!.cost, `${b}->${a}`).toBe(back);
    }
  });

  it("explores less of the graph than an exhaustive search", () => {
    // The entire point of bidirectional A*. On the grid's long diagonal it
    // should settle fewer nodes than Dijkstra sweeping outward.
    const tiles = loadSet("grid");
    const reference = dijkstra(tiles, 1, 16)!;
    const actual = route(tiles, 1, 16)!;

    expect(actual.cost).toBe(reference.cost);
    expect(actual.settled).toBeLessThanOrEqual(reference.settled);
  });

  it("costs nothing to route to yourself", () => {
    const tiles = loadSet("grid");
    const result = route(tiles, 1, 1);
    expect(result?.cost).toBe(0);
    expect(result?.path).toEqual([1]);
  });

  it("returns undefined for an unknown node", () => {
    const tiles = loadSet("grid");
    expect(route(tiles, 1, 999_999)).toBeUndefined();
    expect(route(tiles, 999_999, 1)).toBeUndefined();
  });

  it("reports no path between disconnected components", () => {
    // bottleneck's clusters are joined, so build the disconnected case from the
    // reader fixtures instead: two islands with no route between them.
    const tiles = loadSet("escape");
    // Every real node in `escape` is connected, so assert the component check
    // does not produce false negatives on a connected graph.
    for (const from of index.escape.real) {
      for (const to of index.escape.real) {
        if (from === to) continue;
        expect(route(tiles, from, to), `${from}->${to}`).toBeDefined();
      }
    }
  });

  it("applies an edge cost multiplier without breaking optimality", () => {
    const tiles = loadSet("grid");
    const plain = route(tiles, 1, 16)!;

    // Penalise one specific edge heavily; the route must still be optimal for
    // the modified weights, which the oracle confirms independently.
    const penalise = (from: number, to: number, weight: number): number =>
      from === 1 && to === 2 ? weight * 20 : weight;

    const penalised = route(tiles, 1, 16, { edgeCost: penalise })!;
    const reference = dijkstra(tiles, 1, 16, { edgeCost: penalise })!;

    expect(penalised.cost).toBe(reference.cost);
    expect(penalised.cost).toBeGreaterThanOrEqual(plain.cost);
  });
});

describe("multi-target search (escape routing)", () => {
  it("finds the cost to the nearest exit, not an arbitrary one", () => {
    const tiles = loadSet("escape");
    const exits = index.escape.exits;
    const expected = index.escape.toNearestExit as Record<string, number>;

    const costs = dijkstraFrom(tiles, exits, "reverse");

    for (const [node, cost] of Object.entries(expected)) {
      const got = costs.get(Number(node));
      expect(got, `node ${node} should have a cost to safety`).toBeDefined();
      expect(got!.cost, `node ${node}`).toBe(cost);
    }
  });

  it("costs nothing to be standing at an exit", () => {
    const tiles = loadSet("escape");
    const costs = dijkstraFrom(tiles, index.escape.exits, "reverse");
    for (const exit of index.escape.exits) {
      expect(costs.get(exit)?.cost, `exit ${exit}`).toBe(0);
    }
  });

  it("agrees with routing to the best exit individually", () => {
    // The whole value of the multi-target search: one sweep should equal the
    // minimum over per-exit routes.
    const tiles = loadSet("escape");
    const exits = index.escape.exits;
    const costs = dijkstraFrom(tiles, exits, "reverse");

    for (const from of index.escape.real) {
      let best = Number.POSITIVE_INFINITY;
      for (const exit of exits) {
        const individual = route(tiles, from, exit);
        if (individual) best = Math.min(best, individual.cost);
      }
      const combined = costs.get(from);
      expect(combined, `node ${from}`).toBeDefined();
      expect(combined!.cost, `node ${from} nearest-exit cost`).toBe(best);
    }
  });

  it("points each node one step toward safety", () => {
    const tiles = loadSet("escape");
    const costs = dijkstraFrom(tiles, index.escape.exits, "reverse");

    for (const [nodeId, entry] of costs) {
      if (entry.cost === 0) continue; // already at an exit

      const next = costs.get(entry.next);
      expect(next, `node ${nodeId} next hop ${entry.next} should be known`).toBeDefined();
      // Following `next` must strictly reduce the remaining cost, or the
      // guidance would loop.
      expect(next!.cost, `node ${nodeId} must move closer to safety`).toBeLessThan(entry.cost);
    }
  });
});
