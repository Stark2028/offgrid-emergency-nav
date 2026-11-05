import { Tile, TileSet } from '@offgrid/core';
import { WalkingNetwork, sha256, type Point } from '@offgrid/maps';

let network: WalkingNetwork | undefined;
self.onmessage = async (event: MessageEvent) => {
  const { id, type } = event.data;
  try {
    if (type === 'load') {
      const tiles = new TileSet();
      for (const { bytes, hash } of event.data.tiles as Array<{ bytes: ArrayBuffer; hash: string }>) {
        if (await sha256(bytes) !== hash) throw new Error('A saved routing file is damaged. Check offline files or download this area again.');
        tiles.add(new Tile(bytes));
      }
      network = new WalkingNetwork(tiles, event.data.bounds);
      self.postMessage({ id, type: 'ready' });
    } else if (type === 'plan') {
      if (!network) throw new Error('The offline road network is still loading.');
      const result = network.plan(event.data.start as Point, event.data.destination as Point);
      self.postMessage({ id, type: 'route', result });
    }
  } catch (cause) { self.postMessage({ id, type: 'error', message: cause instanceof Error ? cause.message : 'The route could not be calculated.' }); }
};
