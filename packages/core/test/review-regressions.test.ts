import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Tile } from "../src/graph/tile.js";
import { TileSet } from "../src/graph/tileset.js";
import { route } from "../src/routing/bidirectional-astar.js";
import { dijkstra, dijkstraFrom } from "../src/routing/dijkstra-reference.js";
import minimal from "./fixtures/exact-bound-oneway.json" with { type: "json" };
import fixtures from "./fixtures/routing/index.json" with { type: "json" };

function tiny(): TileSet {
  const tiles = new TileSet();
  for (const encoded of Object.values(minimal.tiles)) {
    const bytes = Buffer.from(encoded, "base64");
    tiles.add(new Tile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  }
  return tiles;
}
function escape(): TileSet {
  const tiles = new TileSet();
  for (const file of fixtures.escape.files) {
    const bytes = readFileSync(new URL(`./fixtures/routing/${file}`, import.meta.url));
    tiles.add(new Tile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  }
  return tiles;
}

describe("review counterexamples", () => {
  it("finds a direct one-way path when endpoint bounds equal its cost", () => {
    const tiles = tiny();
    const actual = route(tiles, minimal.sourceId, minimal.targetId);
    const reference = dijkstra(tiles, minimal.sourceId, minimal.targetId);
    expect(actual?.status).toBe("complete");
    expect(actual?.cost).toBe(2);
    expect(actual?.cost).toBe(reference?.cost);
    expect(actual?.path).toEqual([minimal.sourceId, minimal.targetId]);
    expect(route(tiles, minimal.targetId, minimal.sourceId)).toBeUndefined();
  });
  it("rejects tile bytes whose cost is lower than the serialized distance bound", () => {
    const source = tiny().get(tiny().loaded[0]!)!;
    const bytes = source.lat.buffer.slice(0) as ArrayBuffer;
    new DataView(bytes).setUint32(source.fwdWeight.byteOffset, 1, true);
    expect(() => new Tile(bytes)).toThrow(/geometric lower bound/);
  });
  it("reports missing coverage in nearest-exit searches", () => {
    const full = escape();
    const exit = fixtures.escape.exits[0]!;
    const partial = new TileSet();
    partial.add(full.resolve(exit)!.tile);
    const result = dijkstraFrom(partial, [exit], "reverse");
    expect(result.status).toBe("missing-tiles");
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result).toBeInstanceOf(Map);
  });
  it.each([21, 0, -1, NaN, Infinity, 0.5])("enforces escape-overlay bounds for factor %s", (factor) => {
    expect(() => dijkstraFrom(escape(), fixtures.escape.exits, "reverse", { edgeCost: (_a, _b, weight) => weight * factor })).toThrow();
  });
  it("distinguishes unknown exits and budgets from a completed search", () => {
    expect(dijkstraFrom(escape(), [9999999], "reverse").status).toBe("unknown-endpoints");
    expect(dijkstraFrom(escape(), [], "reverse").status).toBe("unknown-endpoints");
    const limited = dijkstraFrom(escape(), fixtures.escape.exits, "reverse", { maxSettled: 0 });
    expect(limited.status).toBe("budget-exceeded");
    expect(limited.size).toBe(0);
    expect(dijkstraFrom(escape(), fixtures.escape.exits, "reverse").status).toBe("complete");
  });
});
