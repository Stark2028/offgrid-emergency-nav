/**
 * A collection of loaded tiles presented as one graph.
 *
 * Tiles are loaded and evicted independently, so the router needs a view that
 * spans them. The unit of identity across that view is the **global node id**;
 * tile-local slots are an implementation detail that never escapes this class.
 *
 * The key operation is resolving a halo node. A tile's boundary edges point at
 * nodes owned by a neighbour, present locally as halo entries with coordinates
 * but no adjacency. When the search settles one, `resolve` reports which tile
 * needs loading — and once it is resident, the same global id is answered by
 * the owning tile with full adjacency instead.
 */

import { encodeGeohash, TILE_PRECISION } from "../geo/geohash.js";
import { Tile } from "./tile.js";

/** Where a global node id currently lives. */
export interface NodeRef {
  readonly tile: Tile;
  readonly slot: number;
  /** True when this tile only holds a halo stub — adjacency is elsewhere. */
  readonly halo: boolean;
}

/** A node whose adjacency needs a tile that is not loaded. */
export interface UnresolvedNode {
  readonly globalId: number;
  /** The geohash cell that owns it — load this to continue. */
  readonly geohash: string;
  readonly lat: number;
  readonly lon: number;
}

export class TileSet {
  private readonly tiles = new Map<string, Tile>();

  /**
   * Global id -> the tile that owns it (has real adjacency).
   *
   * Halo entries are deliberately absent: a global id is only "owned" by the
   * tile whose cell contains it, so a halo stub never shadows the real node.
   */
  private readonly owners = new Map<number, Tile>();

  get size(): number {
    return this.tiles.size;
  }

  get loaded(): readonly string[] {
    return [...this.tiles.keys()];
  }

  has(geohash: string): boolean {
    return this.tiles.has(geohash);
  }

  add(tile: Tile): void {
    const existing = this.tiles.get(tile.geohash);
    if (existing) return; // already resident; tiles are immutable

    this.tiles.set(tile.geohash, tile);
    for (let slot = 0; slot < tile.nodeCount; slot++) {
      if (!tile.isHalo(slot)) this.owners.set(tile.globalIds[slot]!, tile);
    }
  }

  remove(geohash: string): void {
    const tile = this.tiles.get(geohash);
    if (!tile) return;

    this.tiles.delete(geohash);
    for (let slot = 0; slot < tile.nodeCount; slot++) {
      if (!tile.isHalo(slot)) this.owners.delete(tile.globalIds[slot]!);
    }
  }

  clear(): void {
    this.tiles.clear();
    this.owners.clear();
  }

  get(geohash: string): Tile | undefined {
    return this.tiles.get(geohash);
  }

  /**
   * Locate a global node id.
   *
   * Prefers the owning tile, which carries full adjacency. Falls back to any
   * tile holding a halo stub, so coordinates stay available for the heuristic
   * even while the owner is still loading.
   */
  resolve(globalId: number): NodeRef | undefined {
    const owner = this.owners.get(globalId);
    if (owner) {
      const slot = owner.findSlot(globalId);
      // The owners map and the tile's own id array must agree. If they do not,
      // the tile is not what the index claims -- fall through to the halo scan
      // rather than returning slot -1, which indexes arrays as undefined and
      // launders a missing node past every `!` assertion downstream.
      if (slot >= 0) return { tile: owner, slot, halo: false };
    }

    for (const tile of this.tiles.values()) {
      const slot = tile.findSlot(globalId);
      if (slot >= 0) return { tile, slot, halo: true };
    }
    return undefined;
  }

  /**
   * Which tile a halo node needs, or undefined if it is already resolvable.
   *
   * This is what turns a halo hit during search into a concrete load request.
   */
  unresolved(globalId: number): UnresolvedNode | undefined {
    if (this.owners.has(globalId)) return undefined;

    const ref = this.resolve(globalId);
    if (!ref) return undefined;

    const lat = ref.tile.lat[ref.slot]!;
    const lon = ref.tile.lon[ref.slot]!;
    return {
      globalId,
      geohash: encodeGeohash(lat, lon, TILE_PRECISION),
      lat,
      lon,
    };
  }

  /** Coordinates of a global node id, from the owner or a halo stub. */
  position(globalId: number): { lat: number; lon: number } | undefined {
    const ref = this.resolve(globalId);
    if (!ref) return undefined;
    return { lat: ref.tile.lat[ref.slot]!, lon: ref.tile.lon[ref.slot]! };
  }

  /**
   * Component id of a node, or -1 when unknown.
   *
   * Two nodes in different components have no path between them, so the router
   * can reject the query in O(1) instead of exhausting the search space first.
   */
  component(globalId: number): number {
    const ref = this.resolve(globalId);
    if (!ref) return -1;
    return ref.tile.components[ref.slot] ?? -1;
  }

  /**
   * Outgoing edges of a node, in the given direction.
   *
   * Yields nothing for a node whose owning tile is absent — the caller checks
   * `unresolved` to find out which tile to load.
   */
  *edges(
    globalId: number,
    direction: "forward" | "reverse",
  ): Generator<{ target: number; weight: number; geometry: number }> {
    const owner = this.owners.get(globalId);
    if (!owner) return;

    const slot = owner.findSlot(globalId);
    if (slot < 0) return;

    const forward = direction === "forward";
    const offsets = forward ? owner.fwdOffset : owner.revOffset;
    const targets = forward ? owner.fwdTarget : owner.revTarget;
    const weights = forward ? owner.fwdWeight : owner.revWeight;
    const geometries = forward ? owner.fwdGeometry : owner.revGeometry;

    const start = offsets[slot]!;
    const end = offsets[slot + 1]!;
    for (let i = start; i < end; i++) {
      yield {
        target: owner.globalIds[targets[i]!]!,
        weight: weights[i]!,
        geometry: geometries[i]!,
      };
    }
  }
}
