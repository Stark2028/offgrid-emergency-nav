import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, parseDrawing, sha256 } from '@offgrid/maps';
import { Tile, TileSet, route, dijkstra } from '@offgrid/core';

const web = fileURLToPath(new URL('../', import.meta.url));
const catalogue = JSON.parse(await readFile(resolve(web, 'src/generated/catalog.json'), 'utf8'));
assert.ok(catalogue.regions.length > 0, 'No published packs');
for (const region of catalogue.regions) {
  const base = resolve(web, 'public', `.${region.manifestUrl}`, '..');
  const manifestBytes = await readFile(resolve(base, 'manifest.json'));
  const exactBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  assert.equal(await sha256(exactBuffer(manifestBytes)), region.manifestSha256);
  const manifest = parseManifest(JSON.parse(manifestBytes.toString()), region);
  const tiles = new TileSet();
  for (const asset of manifest.assets) {
    const bytes = await readFile(resolve(base, asset.path));
    assert.equal(bytes.byteLength, asset.bytes);
    assert.equal(await sha256(exactBuffer(bytes)), asset.sha256);
    if (asset.kind === 'routing-tile') tiles.add(new Tile(exactBuffer(bytes)));
    else parseDrawing(JSON.parse(bytes.toString()));
  }
  const nodes = [];
  for (const cell of tiles.loaded) {
    const tile = tiles.get(cell);
    for (let i = 0; i < tile.nodeCount; i++) if (!tile.isHalo(i) && tile.components[i] === 0) nodes.push(tile.globalIds[i]);
  }
  assert.ok(nodes.length > 20, 'No meaningful connected road graph');
  let compared = 0;
  for (let i = 0; i < 60; i++) {
    const source = nodes[(i * 37) % nodes.length];
    const target = nodes[(i * 79 + 13) % nodes.length];
    const actual = route(tiles, source, target);
    const reference = dijkstra(tiles, source, target);
    assert.equal(actual?.cost, reference?.cost, `${region.id}: ${source}->${target}`);
    if (actual) { assert.equal(actual.status, 'complete'); compared++; }
  }
  assert.ok(compared > 10);
  console.log(`${region.id}: ${manifest.assets.length} verified files, ${compared} real-OSM route comparisons, ${manifest.totalBytes} bytes.`);
}
