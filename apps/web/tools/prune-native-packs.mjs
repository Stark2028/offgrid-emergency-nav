import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

// Only the generated Android copy is pruned. The web publication retains old
// immutable generations for existing clients and rollback.
const appRoot = resolve(import.meta.dirname, '..');
const packRoot = resolve(appRoot, 'android/app/src/main/assets/public/packs');
const catalogue = JSON.parse(await readFile(resolve(appRoot, 'src/generated/catalog.json'), 'utf8'));
const active = new Map(catalogue.regions.map(r => [r.id, r.datasetId]));
for (const region of await readdir(packRoot, { withFileTypes: true })) {
  if (!region.isDirectory() || !/^[a-z0-9-]+$/.test(region.name)) continue;
  const regionPath = resolve(packRoot, region.name);
  for (const generation of await readdir(regionPath, { withFileTypes: true })) {
    if (!generation.isDirectory() || !/^[a-f0-9]{64}$/.test(generation.name) || active.get(region.name) === generation.name) continue;
    const target = resolve(regionPath, generation.name), local = relative(packRoot, target);
    if (!local || local.startsWith(`..${sep}`) || local === '..' || resolve(packRoot, local) !== target) throw new Error('Refusing an invalid generated-pack path');
    await rm(target, { recursive: true, force: false });
  }
}
console.log('Android copy contains only catalogue-pinned map generations.');
