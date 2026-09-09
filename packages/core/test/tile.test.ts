import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Tile } from "../src/graph/tile.js";
import { TileSet } from "../src/graph/tileset.js";
import { GEOMETRY_REVERSED, TILE_MAGIC, TILE_VERSION } from "../src/graph/format.js";
import index from "./fixtures/tiles/index.json" with { type: "json" };

/**
 * These tiles are written by the real Python serialiser
 * (packages/pipeline/tools/gen_tile_fixtures.py), so these tests verify the
 * reader against bytes the pipeline actually produces — not bytes TypeScript
 * produced for itself, which would pass even if the two disagreed.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tiles");

type CaseName = keyof typeof index;

function loadTiles(name: CaseName): Tile[] {
  return index[name].files.map((file) => {
    const bytes = readFileSync(join(FIXTURES, file));
    // Copy out of Node's pooled Buffer: its byteOffset is rarely 0, and the
    // typed-array views in Tile assume the tile starts at offset 0.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Tile(buffer as ArrayBuffer);
  });
}

function loadSet(name: CaseName): TileSet {
  const set = new TileSet();
  for (const tile of loadTiles(name)) set.add(tile);
  return set;
}

describe("Tile header", () => {
  it("reads magic and version from pipeline output", () => {
    const [tile] = loadTiles("single-cell");
    expect(tile!.header.nodeCount).toBeGreaterThan(0);
    // Constructing at all proves magic/version matched; assert them explicitly.
    expect(TILE_MAGIC).toBe(0x4f475254);
    expect(TILE_VERSION).toBe(1);
  });

  it("rejects a buffer that is not a tile", () => {
    const junk = new ArrayBuffer(128);
    expect(() => new Tile(junk)).toThrow(/bad tile magic/);
  });

  it("rejects a truncated buffer", () => {
    expect(() => new Tile(new ArrayBuffer(16))).toThrow(/truncated/);
  });

  it("reports a bbox containing every node it holds", () => {
    for (const tile of loadTiles("junction")) {
      for (let slot = 0; slot < tile.nodeCount; slot++) {
        if (tile.isHalo(slot)) continue; // halo nodes live in a neighbour
        expect(tile.contains(tile.lat[slot]!, tile.lon[slot]!)).toBe(true);
      }
    }
  });
});

describe("Tile node table", () => {
  it("stores global ids in ascending order so lookup can binary-search", () => {
    for (const tile of loadTiles("junction")) {
      for (let slot = 1; slot < tile.nodeCount; slot++) {
        expect(tile.globalIds[slot]!).toBeGreaterThan(tile.globalIds[slot - 1]!);
      }
    }
  });

  it("finds every node it contains, and rejects ones it does not", () => {
    const [tile] = loadTiles("single-cell");
    for (let slot = 0; slot < tile!.nodeCount; slot++) {
      expect(tile!.findSlot(tile!.globalIds[slot]!)).toBe(slot);
    }
    expect(tile!.findSlot(999_999)).toBe(-1);
  });

  it("agrees with the pipeline on coordinates", () => {
    const set = loadSet("junction");
    for (const [globalId, expected] of Object.entries(index.junction.nodes)) {
      const position = set.position(Number(globalId));
      expect(position, `node ${globalId}`).toBeDefined();
      // float32 in the tile, float64 in the JSON.
      expect(position!.lat).toBeCloseTo(expected.lat, 5);
      expect(position!.lon).toBeCloseTo(expected.lon, 5);
    }
  });

  it("agrees with the pipeline on component ids", () => {
    const set = loadSet("disconnected");
    for (const [globalId, expected] of Object.entries(index.disconnected.nodes)) {
      expect(set.component(Number(globalId)), `node ${globalId}`).toBe(expected.component);
    }
  });
});

describe("Tile adjacency", () => {
  it("reproduces every edge the pipeline recorded", () => {
    const set = loadSet("junction");
    const found = new Set<string>();

    for (const globalId of Object.keys(index.junction.nodes).map(Number)) {
      for (const edge of set.edges(globalId, "forward")) {
        found.add(`${globalId}->${edge.target}`);
      }
    }

    for (const edge of index.junction.edges) {
      expect(found, `${edge.source}->${edge.target}`).toContain(`${edge.source}->${edge.target}`);
    }
  });

  it("agrees with the pipeline on edge weights", () => {
    const set = loadSet("junction");
    const expected = new Map(
      index.junction.edges.map((e) => [`${e.source}->${e.target}`, e.weight]),
    );

    for (const globalId of Object.keys(index.junction.nodes).map(Number)) {
      for (const edge of set.edges(globalId, "forward")) {
        const key = `${globalId}->${edge.target}`;
        if (expected.has(key)) expect(edge.weight, key).toBe(expected.get(key));
      }
    }
  });

  it("keeps a one-way street one-way", () => {
    const set = loadSet("oneway");
    const [source, target] = [index.oneway.edges[0]!.source, index.oneway.edges[0]!.target];

    const forward = [...set.edges(source, "forward")].map((e) => e.target);
    const backward = [...set.edges(target, "forward")].map((e) => e.target);

    expect(forward).toContain(target);
    expect(backward).not.toContain(source);
  });

  it("reverse adjacency mirrors forward adjacency", () => {
    // The backward half of bidirectional A* depends on this exactly.
    const set = loadSet("junction");
    const ids = Object.keys(index.junction.nodes).map(Number);

    const forward = new Set<string>();
    for (const id of ids) {
      for (const edge of set.edges(id, "forward")) forward.add(`${id}->${edge.target}`);
    }

    const reverse = new Set<string>();
    for (const id of ids) {
      for (const edge of set.edges(id, "reverse")) reverse.add(`${edge.target}->${id}`);
    }

    expect([...reverse].sort()).toEqual([...forward].sort());
  });
});

describe("Tile geometry", () => {
  it("decodes the interior shape of a simplified edge", () => {
    // single-cell collapses a 4-node way, leaving 2 interior shape points.
    const set = loadSet("single-cell");
    const [tile] = loadTiles("single-cell");
    const source = index["single-cell"].edges[0]!.source;

    const [edge] = [...set.edges(source, "forward")];
    const geometry = tile!.edgeGeometry(edge!.geometry);

    expect(geometry.lat.length).toBe(2);
    expect(geometry.lat.length).toBe(geometry.lon.length);
  });

  it("returns a reversed edge's shape in travel order", () => {
    // Forward and reverse share one stored copy; the tag flips the order, so a
    // drawn route always runs source-to-target.
    const [tile] = loadTiles("single-cell");
    const set = loadSet("single-cell");
    const { source, target } = index["single-cell"].edges[0]!;

    const forwardEdge = [...set.edges(source, "forward")][0]!;
    const backwardEdge = [...set.edges(target, "forward")][0]!;

    const forward = tile!.edgeGeometry(forwardEdge.geometry);
    const backward = tile!.edgeGeometry(backwardEdge.geometry);

    expect(backward.lat.length).toBe(forward.lat.length);
    for (let i = 0; i < forward.lat.length; i++) {
      const mirrored = forward.lat.length - 1 - i;
      expect(backward.lat[i]).toBeCloseTo(forward.lat[mirrored]!, 5);
      expect(backward.lon[i]).toBeCloseTo(forward.lon[mirrored]!, 5);
    }
  });

  it("shares one stored copy between an edge and its reverse", () => {
    // The size fix: both directions reference the same offset, differing only
    // in the direction tag.
    const set = loadSet("single-cell");
    const { source, target } = index["single-cell"].edges[0]!;

    const forward = [...set.edges(source, "forward")][0]!.geometry;
    const backward = [...set.edges(target, "forward")][0]!.geometry;

    expect(forward & ~GEOMETRY_REVERSED).toBe(backward & ~GEOMETRY_REVERSED);
    expect((forward & GEOMETRY_REVERSED) !== (backward & GEOMETRY_REVERSED)).toBe(true);
  });
});

describe("TileSet boundaries", () => {
  it("resolves a node owned by another loaded tile", () => {
    const set = loadSet("crossing");
    for (const globalId of Object.keys(index.crossing.nodes).map(Number)) {
      const ref = set.resolve(globalId);
      expect(ref, `node ${globalId}`).toBeDefined();
      expect(ref!.halo).toBe(false); // both tiles loaded, so owners are present
    }
  });

  it("reports which tile a halo node needs when its owner is absent", () => {
    const tiles = loadTiles("crossing");
    const set = new TileSet();
    set.add(tiles[0]!); // deliberately load only one side

    const nodes = index.crossing.nodes;
    const foreign = Object.entries(nodes).find(([, n]) => n.cell !== tiles[0]!.geohash);
    expect(foreign, "fixture must have a node in the other cell").toBeDefined();

    const pending = set.unresolved(Number(foreign![0]));
    expect(pending).toBeDefined();
    expect(pending!.geohash).toBe(foreign![1].cell);
  });

  it("yields no edges for a node whose owning tile is missing", () => {
    const tiles = loadTiles("crossing");
    const set = new TileSet();
    set.add(tiles[0]!);

    const foreign = Object.entries(index.crossing.nodes).find(
      ([, n]) => n.cell !== tiles[0]!.geohash,
    )!;
    expect([...set.edges(Number(foreign[0]), "forward")]).toHaveLength(0);
  });

  it("crosses a tile boundary once both sides are loaded", () => {
    const set = loadSet("crossing");
    const { source, target } = index.crossing.edges[0]!;

    const targets = [...set.edges(source, "forward")].map((e) => e.target);
    expect(targets).toContain(target);
  });

  it("forgets a tile's nodes when it is evicted", () => {
    const set = loadSet("crossing");
    const [first] = set.loaded;

    const before = set.size;
    set.remove(first!);
    expect(set.size).toBe(before - 1);
    expect(set.has(first!)).toBe(false);
  });

  it("ignores a duplicate add of the same cell", () => {
    const tiles = loadTiles("crossing");
    const set = new TileSet();
    set.add(tiles[0]!);
    set.add(tiles[0]!);
    expect(set.size).toBe(1);
  });
});

describe("TileSet components", () => {
  it("gives disconnected islands different component ids", () => {
    const set = loadSet("disconnected");
    const ids = Object.entries(index.disconnected.nodes);

    const groups = new Map<number, number[]>();
    for (const [globalId, node] of ids) {
      const list = groups.get(node.component) ?? [];
      list.push(Number(globalId));
      groups.set(node.component, list);
    }

    expect(groups.size).toBeGreaterThan(1);
    for (const [component, members] of groups) {
      for (const member of members) expect(set.component(member)).toBe(component);
    }
  });

  it("returns -1 for a node it has never seen", () => {
    expect(loadSet("single-cell").component(999_999)).toBe(-1);
  });
});
