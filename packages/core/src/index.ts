/**
 * Public surface of @offgrid/core.
 *
 * Everything here is DOM-free and runs in Node, which is what lets routing
 * correctness be verified in a test harness with no browser in the loop.
 */

// Geo primitives
export {
  encodeGeohash,
  geohashBounds,
  geohashNeighbours,
  geohashesInBounds,
  TILE_PRECISION,
  type GeoBounds,
} from "./geo/geohash.js";
export { haversineMetres, heuristicWeight, MAX_SPEED_MPS } from "./geo/distance.js";

// Binary tile format
export {
  GEOMETRY_OFFSET_MASK,
  GEOMETRY_REVERSED,
  HEADER_BYTES,
  NODE_FLAG_HALO,
  NODE_FLAG_JUNCTION,
  readHeader,
  TILE_MAGIC,
  TILE_VERSION,
  WEIGHT_MAX,
  WEIGHT_SCALE,
  packGeohash,
  unpackGeohash,
  type TileHeader,
} from "./graph/format.js";

// Graph access
export { Tile, type EdgeGeometry } from "./graph/tile.js";
export { TileSet, type NodeRef, type UnresolvedNode } from "./graph/tileset.js";

// Routing
export { MinHeap } from "./routing/heap.js";
export {
  dijkstra,
  dijkstraFrom,
  type DijkstraOptions,
  type DijkstraResult,
} from "./routing/dijkstra-reference.js";
export { route, type RouteOptions, type RouteResult } from "./routing/bidirectional-astar.js";
