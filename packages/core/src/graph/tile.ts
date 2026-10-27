/**
 * Reading one binary tile.
 *
 * Typed-array views over the tile's ArrayBuffer — no copying, no parsing step.
 * Construction validates the layout and graph records once before use.
 * Treat the input buffer and exposed array views as immutable after validation.
 *
 * Layout is defined in format.ts and written by packages/pipeline/tiles.py.
 */

import {
  GEOMETRY_OFFSET_MASK,
  GEOMETRY_REVERSED,
  HEADER_BYTES,
  NODE_FLAG_HALO,
  NODE_FLAG_JUNCTION,
  readHeader,
  type TileHeader,
} from "./format.js";

/** Interior shape of one edge — the points between its endpoints. */
export interface EdgeGeometry {
  readonly lat: Float32Array;
  readonly lon: Float32Array;
}

/**
 * One geohash cell's slice of the road graph.
 *
 * Node indices in this class are *tile-local slots*. Global ids live in
 * `globalIds` and are what cross tile boundaries; `TileSet` maps between them.
 */
export class Tile {
  readonly header: TileHeader;

  readonly lat: Float32Array;
  readonly lon: Float32Array;
  /** Global node ids, ascending — so `findSlot` can binary-search. */
  readonly globalIds: Uint32Array;
  readonly components: Uint16Array;
  readonly flags: Uint8Array;

  readonly fwdOffset: Uint32Array;
  readonly fwdTarget: Uint32Array;
  readonly fwdWeight: Uint32Array;
  readonly fwdGeometry: Uint32Array;

  readonly revOffset: Uint32Array;
  readonly revTarget: Uint32Array;
  readonly revWeight: Uint32Array;
  readonly revGeometry: Uint32Array;

  private readonly geometry: DataView;

  constructor(buffer: ArrayBuffer) {
    this.header = readHeader(buffer);
    const { nodeCount, fwdEdgeCount, revEdgeCount } = this.header;

    let offset = HEADER_BYTES;
    const take = <T>(make: (buf: ArrayBuffer, off: number, len: number) => T, count: number, bytes: number): T => {
      const view = make(buffer, offset, count);
      offset += count * bytes;
      return view;
    };

    this.lat = take((b, o, n) => new Float32Array(b, o, n), nodeCount, 4);
    this.lon = take((b, o, n) => new Float32Array(b, o, n), nodeCount, 4);
    this.globalIds = take((b, o, n) => new Uint32Array(b, o, n), nodeCount, 4);
    this.components = take((b, o, n) => new Uint16Array(b, o, n), nodeCount, 2);
    this.flags = take((b, o, n) => new Uint8Array(b, o, n), nodeCount, 1);

    // The writer realigns to 4 bytes before the u32 arrays; typed-array views
    // throw on a misaligned offset, so this must mirror it exactly.
    offset += (4 - (offset % 4)) % 4;

    this.fwdOffset = take((b, o, n) => new Uint32Array(b, o, n), nodeCount + 1, 4);
    this.fwdTarget = take((b, o, n) => new Uint32Array(b, o, n), fwdEdgeCount, 4);
    this.fwdWeight = take((b, o, n) => new Uint32Array(b, o, n), fwdEdgeCount, 4);
    this.fwdGeometry = take((b, o, n) => new Uint32Array(b, o, n), fwdEdgeCount, 4);

    this.revOffset = take((b, o, n) => new Uint32Array(b, o, n), nodeCount + 1, 4);
    this.revTarget = take((b, o, n) => new Uint32Array(b, o, n), revEdgeCount, 4);
    this.revWeight = take((b, o, n) => new Uint32Array(b, o, n), revEdgeCount, 4);
    this.revGeometry = take((b, o, n) => new Uint32Array(b, o, n), revEdgeCount, 4);

    this.geometry = new DataView(buffer, this.header.geometryOffset, this.header.geometryBytes);
    this.validate();
  }

  /** Validate once at ingestion, before malformed graph data reaches a search. */
  private validate(): void {
    const validPosition = (lat: number, lon: number): boolean =>
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    for (let slot = 0; slot < this.nodeCount; slot++) {
      if (!validPosition(this.lat[slot]!, this.lon[slot]!)) throw new Error("invalid tile node coordinate");
      if (slot > 0 && this.globalIds[slot]! <= this.globalIds[slot - 1]!) {
        throw new Error("tile node ids must be strictly ascending");
      }
      if ((this.flags[slot]! & ~(NODE_FLAG_HALO | NODE_FLAG_JUNCTION)) !== 0) {
        throw new Error("invalid tile node flags");
      }
    }

    // Only record starts are valid references, never the middle of a point.
    const geometryStarts = new Set<number>();
    let cursor = 0;
    while (cursor < this.geometry.byteLength) {
      if (cursor + 2 > this.geometry.byteLength) throw new Error("truncated tile geometry");
      geometryStarts.add(cursor);
      const count = this.geometry.getUint16(cursor, true);
      const end = cursor + 2 + count * 8;
      if (end > this.geometry.byteLength) throw new Error("truncated tile geometry points");
      for (let point = cursor + 2; point < end; point += 8) {
        if (!validPosition(this.geometry.getFloat32(point, true), this.geometry.getFloat32(point + 4, true))) {
          throw new Error("invalid tile geometry coordinate");
        }
      }
      cursor = end;
    }
    for (const [offsets, targets, weights, geometries] of [
      [this.fwdOffset, this.fwdTarget, this.fwdWeight, this.fwdGeometry],
      [this.revOffset, this.revTarget, this.revWeight, this.revGeometry],
    ] as const) {
      if (offsets[0] !== 0 || offsets[this.nodeCount] !== targets.length) {
        throw new Error("invalid tile CSR sentinel");
      }
      for (let slot = 0; slot < this.nodeCount; slot++) {
        if (offsets[slot]! > offsets[slot + 1]! || offsets[slot + 1]! > targets.length) {
          throw new Error("invalid tile CSR offsets");
        }
        if (this.isHalo(slot) && offsets[slot] !== offsets[slot + 1]) {
          throw new Error("tile halo must not carry adjacency");
        }
      }
      for (let edge = 0; edge < targets.length; edge++) {
        if (targets[edge]! >= this.nodeCount) throw new Error("invalid tile edge target");
        if (weights[edge] === 0) throw new Error("invalid tile edge weight");
        if (!geometryStarts.has(geometries[edge]! & GEOMETRY_OFFSET_MASK)) {
          throw new Error("invalid tile geometry reference");
        }
      }
    }
  }

  get geohash(): string {
    return this.header.geohash;
  }

  get nodeCount(): number {
    return this.header.nodeCount;
  }

  /**
   * A halo node lives in a neighbouring tile and appears here only as an edge
   * target. It has coordinates but no outgoing adjacency — settling one during
   * search means "load the owning tile and resume".
   */
  isHalo(slot: number): boolean {
    return (this.flags[slot]! & NODE_FLAG_HALO) !== 0;
  }

  isJunction(slot: number): boolean {
    return (this.flags[slot]! & NODE_FLAG_JUNCTION) !== 0;
  }

  /** Tile-local slot for a global node id, or -1 if this tile has no entry. */
  findSlot(globalId: number): number {
    const ids = this.globalIds;
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = ids[mid]!;
      if (value === globalId) return mid;
      if (value < globalId) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Interior shape of an edge, empty when it is a straight segment.
   *
   * `reference` is the tagged value from `fwdGeometry`/`revGeometry`: an offset
   * plus a high bit meaning "read back-to-front". An edge and its reverse share
   * one stored copy, so the points come out ordered source-to-target either way
   * and a drawn route always runs in the direction of travel.
   */
  edgeGeometry(reference: number): EdgeGeometry {
    const offset = reference & GEOMETRY_OFFSET_MASK;
    const reversed = (reference & GEOMETRY_REVERSED) !== 0;

    const count = this.geometry.getUint16(offset, true);
    const lat = new Float32Array(count);
    const lon = new Float32Array(count);

    let cursor = offset + 2;
    for (let i = 0; i < count; i++) {
      const index = reversed ? count - 1 - i : i;
      lat[index] = this.geometry.getFloat32(cursor, true);
      lon[index] = this.geometry.getFloat32(cursor + 4, true);
      cursor += 8;
    }
    return { lat, lon };
  }

  /** Whether a coordinate falls inside this tile's cell. */
  contains(lat: number, lon: number): boolean {
    const h = this.header;
    return lat >= h.minLat && lat <= h.maxLat && lon >= h.minLon && lon <= h.maxLon;
  }
}
