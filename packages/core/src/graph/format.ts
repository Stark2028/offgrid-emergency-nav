/**
 * Binary tile format — the contract between the Python pipeline and the TS runtime.
 *
 * A tile holds the slice of the road graph inside one geohash-6 cell, stored as
 * CSR (compressed sparse row) adjacency over flat typed arrays. Both a forward
 * and a reverse adjacency are materialised: the backward half of bidirectional
 * A* must traverse edges that point *into* a node, and deriving that at runtime
 * from the forward arrays is where one-way-street bugs come from.
 *
 * Layout is little-endian throughout (every platform we target is LE, and
 * DataView byte-swapping on hot paths is not worth it).
 *
 * ┌─ header (64 bytes, see HEADER_* offsets)
 * ├─ nodeLat        Float32 × nodeCount
 * ├─ nodeLon        Float32 × nodeCount
 * ├─ nodeGlobalId   Uint32  × nodeCount   ascending — enables binary search
 * ├─ nodeComponent  Uint16  × nodeCount   connected-component id
 * ├─ nodeFlags      Uint8   × nodeCount   NODE_FLAG_*
 * ├─ (pad to 4)
 * ├─ fwdOffset      Uint32  × (nodeCount + 1)
 * ├─ fwdTarget      Uint32  × fwdEdgeCount   local slot, or halo index
 * ├─ fwdWeight      Uint32  × fwdEdgeCount   centiseconds of travel time
 * ├─ fwdGeometry    Uint32  × fwdEdgeCount   byte offset into geometry blob
 * ├─ revOffset      Uint32  × (nodeCount + 1)
 * ├─ revTarget      Uint32  × revEdgeCount
 * ├─ revWeight      Uint32  × revEdgeCount
 * ├─ revGeometry    Uint32  × revEdgeCount
 * └─ geometry       packed polylines (see decodeGeometry)
 */

export const TILE_MAGIC = 0x4f47_5254; // "OGRT" — OffGrid Route Tile
export const TILE_VERSION = 1;

export const HEADER_BYTES = 64;

// Header field byte offsets.
export const HEADER_MAGIC = 0;
export const HEADER_VERSION = 4;
export const HEADER_NODE_COUNT = 8;
export const HEADER_FWD_EDGE_COUNT = 12;
export const HEADER_REV_EDGE_COUNT = 16;
export const HEADER_GEOHASH_LO = 20; // geohash-6 cell, 6 chars packed as 2 × u32
export const HEADER_GEOHASH_HI = 24;
export const HEADER_GEOMETRY_OFFSET = 28;
export const HEADER_GEOMETRY_BYTES = 32;
export const HEADER_MIN_LAT = 36; // Float32 tile bbox, for corridor selection
export const HEADER_MIN_LON = 40;
export const HEADER_MAX_LAT = 44;
export const HEADER_MAX_LON = 48;
// 52..64 reserved.

/**
 * Node is a halo: it lives in a neighbouring tile and appears here only as an
 * edge target. Its coordinates are present (so the heuristic can be evaluated
 * without loading the neighbour) but it has no outgoing adjacency in this tile.
 * Settling one during search means "load the owning tile and resume".
 */
export const NODE_FLAG_HALO = 1 << 0;

/** Node was kept through simplification because it is a real intersection. */
export const NODE_FLAG_JUNCTION = 1 << 1;

/**
 * Edge weights are integers — centiseconds of travel time.
 *
 * Float weights are the classic subtle bug here: accumulated rounding makes the
 * forward and backward searches disagree about the cost of the same path, so the
 * meeting-point comparison picks a marginally wrong node and the fuzz test goes
 * flaky in a way that looks like a logic error. Integers make the search exactly
 * reproducible. Centiseconds keep a 12-hour trip inside u32 with room to spare.
 */
export const WEIGHT_SCALE = 100; // weight units per second

/** Weight standing in for "impassable". Kept finite — see hazard/trust.ts. */
export const WEIGHT_MAX = 0xffff_ffff;

export interface TileHeader {
  readonly nodeCount: number;
  readonly fwdEdgeCount: number;
  readonly revEdgeCount: number;
  readonly geohash: string;
  readonly geometryOffset: number;
  readonly geometryBytes: number;
  readonly minLat: number;
  readonly minLon: number;
  readonly maxLat: number;
  readonly maxLon: number;
}

/** Packs a 6-char geohash into two u32s for the fixed-size header. */
export function packGeohash(geohash: string): [lo: number, hi: number] {
  if (geohash.length !== 6) {
    throw new Error(`expected geohash-6, got ${geohash.length} chars: ${geohash}`);
  }
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 3; i++) {
    lo |= geohash.charCodeAt(i) << (i * 8);
    hi |= geohash.charCodeAt(i + 3) << (i * 8);
  }
  return [lo >>> 0, hi >>> 0];
}

export function unpackGeohash(lo: number, hi: number): string {
  let out = "";
  for (let i = 0; i < 3; i++) out += String.fromCharCode((lo >>> (i * 8)) & 0xff);
  for (let i = 0; i < 3; i++) out += String.fromCharCode((hi >>> (i * 8)) & 0xff);
  return out;
}

export function readHeader(buffer: ArrayBuffer): TileHeader {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`tile truncated: ${buffer.byteLength} bytes, need >= ${HEADER_BYTES}`);
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(HEADER_MAGIC, true);
  if (magic !== TILE_MAGIC) {
    throw new Error(`bad tile magic 0x${magic.toString(16)}, expected 0x${TILE_MAGIC.toString(16)}`);
  }
  const version = view.getUint32(HEADER_VERSION, true);
  if (version !== TILE_VERSION) {
    throw new Error(`tile version ${version} unsupported, expected ${TILE_VERSION}`);
  }
  return {
    nodeCount: view.getUint32(HEADER_NODE_COUNT, true),
    fwdEdgeCount: view.getUint32(HEADER_FWD_EDGE_COUNT, true),
    revEdgeCount: view.getUint32(HEADER_REV_EDGE_COUNT, true),
    geohash: unpackGeohash(
      view.getUint32(HEADER_GEOHASH_LO, true),
      view.getUint32(HEADER_GEOHASH_HI, true),
    ),
    geometryOffset: view.getUint32(HEADER_GEOMETRY_OFFSET, true),
    geometryBytes: view.getUint32(HEADER_GEOMETRY_BYTES, true),
    minLat: view.getFloat32(HEADER_MIN_LAT, true),
    minLon: view.getFloat32(HEADER_MIN_LON, true),
    maxLat: view.getFloat32(HEADER_MAX_LAT, true),
    maxLon: view.getFloat32(HEADER_MAX_LON, true),
  };
}
