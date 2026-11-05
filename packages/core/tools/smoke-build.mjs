// Exercise the same package export an application imports, without a TS loader.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Tile, TileSet, route } from "@offgrid/core";

const metadata = JSON.parse(readFileSync(new URL("../test/fixtures/routing/index.json", import.meta.url), "utf8"));
const tiles = new TileSet();
for (const file of metadata.grid.files) {
  const bytes = readFileSync(new URL(`../test/fixtures/routing/${file}`, import.meta.url));
  tiles.add(new Tile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
}
for (const [pair, expected] of Object.entries(metadata.grid.shortest)) {
  const [from, to] = pair.split("->").map(Number);
  const result = route(tiles, from, to);
  assert.equal(result?.status, "complete");
  assert.equal(result?.cost, expected, pair);
}
console.log("Built package imports and routes correctly through @offgrid/core.");
