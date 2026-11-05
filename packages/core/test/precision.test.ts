import { expect, it } from "vitest";
import { Tile } from "../src/graph/tile.js";
import { TileSet } from "../src/graph/tileset.js";
import { heuristicWeight } from "../src/geo/distance.js";
import { route } from "../src/routing/bidirectional-astar.js";
import fixtures from "./fixtures/precision.json" with { type: "json" };

it("preserves consistent heuristics and independent route costs after coordinate serialization", () => {
  let comparisons = 0;
  for (const fixture of fixtures) {
    const tiles = new TileSet();
    for (const encoded of Object.values(fixture.tiles)) {
      const bytes = Buffer.from(encoded, "base64");
      tiles.add(new Tile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    }
    const h = (a: number, b: number) => { const p = tiles.position(a)!; const q = tiles.position(b)!; return heuristicWeight(p.lat, p.lon, q.lat, q.lon, 100); };
    for (const source of fixture.nodes) {
      for (const goal of fixture.nodes) {
        for (const edge of tiles.edges(source, "forward")) expect(h(source, goal), `case ${fixture.case}: inconsistent bound`).toBeLessThanOrEqual(edge.weight + h(edge.target, goal));
        const expected = (fixture.costs as Record<string, number>)[`${source}->${goal}`];
        const actual = route(tiles, source, goal);
        expect(actual?.cost, `case ${fixture.case}: ${source}->${goal}`).toBe(expected);
        if (actual) {
          expect(actual.status).toBe("complete");
          let cost = 0;
          for (let i = 1; i < actual.path.length; i++) {
            const weights = [...tiles.edges(actual.path[i - 1]!, "forward")].filter((edge) => edge.target === actual.path[i]).map((edge) => edge.weight);
            cost += Math.min(...weights);
          }
          expect(cost).toBe(actual.cost);
        }
        comparisons++;
      }
    }
  }
  expect(comparisons).toBeGreaterThan(3000);
  console.info(`Verified ${comparisons} serialized precision queries against independent Python costs.`);
});
