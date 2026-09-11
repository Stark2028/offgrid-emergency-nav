/**
 * Reference Dijkstra — the correctness oracle.
 *
 * This exists to be *obviously* right, not fast. Bidirectional A* has several
 * ways to be subtly wrong (inconsistent potentials, premature termination, a
 * backward search that walks forward edges) and every one of them produces
 * plausible routes that are quietly suboptimal. Without something to diff
 * against, those bugs are invisible: the app draws a line, the line looks fine,
 * and nobody finds out it was 8% longer than it needed to be.
 *
 * So: no heuristic, no bidirectional search, no early exit, no tricks. If this
 * and the optimised router ever disagree, the optimised router is wrong.
 *
 * Deliberately kept simple enough to audit by reading.
 */

import type { TileSet } from "../graph/tileset.js";
import { MinHeap } from "./heap.js";

/** Sentinel for "no predecessor" in the parent map. */
const NO_PARENT = -1;

export interface DijkstraResult {
  /** Total path cost in the integer weight units of format.ts. */
  readonly cost: number;
  /** Global node ids from source to target inclusive. */
  readonly path: readonly number[];
  /** Nodes removed from the queue. Useful for comparing search effort. */
  readonly settled: number;
}

export interface DijkstraOptions {
  /**
   * Per-edge cost multiplier, applied as the search relaxes each edge.
   *
   * This is how hazards enter routing: a reported barricade scales the edges
   * near it rather than deleting them. Returning a larger number makes an edge
   * less attractive; the router never sees an infinite weight, which is a
   * deliberate safety property (see TASKS.md Phase 4).
   */
  readonly edgeCost?: (source: number, target: number, weight: number) => number;
}

/**
 * Shortest path from `source` to `target`, or undefined when none exists.
 *
 * Runs over an in-memory `TileSet`: every tile the path might touch must
 * already be loaded. The reference implementation deliberately does not do
 * demand-driven tile loading — that is one more thing that could be wrong, and
 * the oracle's whole value is being simple.
 */
export function dijkstra(
  tiles: TileSet,
  source: number,
  target: number,
  options: DijkstraOptions = {},
): DijkstraResult | undefined {
  if (tiles.resolve(source) === undefined) return undefined;
  if (tiles.resolve(target) === undefined) return undefined;

  if (source === target) {
    return { cost: 0, path: [source], settled: 0 };
  }

  // Two nodes in different components have no path between them. Checking up
  // front turns a full exhaustion of the reachable graph into an O(1) answer.
  const sourceComponent = tiles.component(source);
  const targetComponent = tiles.component(target);
  if (sourceComponent >= 0 && targetComponent >= 0 && sourceComponent !== targetComponent) {
    return undefined;
  }

  const edgeCost = options.edgeCost;

  // Global ids are sparse, so the frontier is keyed by a dense index assigned
  // on first sight. The heap needs a capacity up front and dense slots.
  const indexOf = new Map<number, number>();
  const globalId: number[] = [];
  const distance: number[] = [];
  const parent: number[] = [];
  const settled: boolean[] = [];

  const intern = (id: number): number => {
    let index = indexOf.get(id);
    if (index === undefined) {
      index = globalId.length;
      indexOf.set(id, index);
      globalId.push(id);
      distance.push(Number.POSITIVE_INFINITY);
      parent.push(NO_PARENT);
      settled.push(false);
    }
    return index;
  };

  // Capacity: the heap indexes by dense slot, and slots are created lazily, so
  // it must be able to hold every node the search could reach. The component
  // is an upper bound we cannot cheaply count, so grow-on-demand is simpler —
  // MinHeap is fixed-capacity, so size it to the whole loaded graph.
  let capacity = 0;
  for (const geohash of tiles.loaded) capacity += tiles.get(geohash)!.nodeCount;

  const heap = new MinHeap(Math.max(capacity, 1));

  const sourceIndex = intern(source);
  distance[sourceIndex] = 0;
  heap.push(sourceIndex, 0);

  let settledCount = 0;

  while (!heap.isEmpty()) {
    const currentIndex = heap.pop();
    if (currentIndex < 0) break;
    if (settled[currentIndex]) continue;

    settled[currentIndex] = true;
    settledCount++;

    const currentId = globalId[currentIndex]!;
    if (currentId === target) {
      return {
        cost: distance[currentIndex]!,
        path: reconstruct(parent, globalId, currentIndex),
        settled: settledCount,
      };
    }

    const currentDistance = distance[currentIndex]!;

    for (const edge of tiles.edges(currentId, "forward")) {
      const weight = edgeCost ? edgeCost(currentId, edge.target, edge.weight) : edge.weight;
      const candidate = currentDistance + weight;

      const neighbourIndex = intern(edge.target);
      if (settled[neighbourIndex]) continue;

      if (candidate < distance[neighbourIndex]!) {
        distance[neighbourIndex] = candidate;
        parent[neighbourIndex] = currentIndex;
        heap.push(neighbourIndex, candidate);
      }
    }
  }

  return undefined;
}

/**
 * Cost to every node reachable from `sources`, as one search.
 *
 * Seeding the queue with many zero-cost origins is exactly "distance to the
 * nearest of these", which is what escape routing needs: run it over the
 * *reverse* graph from every safe exit and each node learns its cost to the
 * closest way out. One search, not one per exit.
 */
export function dijkstraFrom(
  tiles: TileSet,
  sources: readonly number[],
  direction: "forward" | "reverse",
  options: DijkstraOptions = {},
): Map<number, { cost: number; next: number }> {
  const edgeCost = options.edgeCost;

  const indexOf = new Map<number, number>();
  const globalId: number[] = [];
  const distance: number[] = [];
  const parent: number[] = [];
  const settled: boolean[] = [];

  const intern = (id: number): number => {
    let index = indexOf.get(id);
    if (index === undefined) {
      index = globalId.length;
      indexOf.set(id, index);
      globalId.push(id);
      distance.push(Number.POSITIVE_INFINITY);
      parent.push(NO_PARENT);
      settled.push(false);
    }
    return index;
  };

  let capacity = 0;
  for (const geohash of tiles.loaded) capacity += tiles.get(geohash)!.nodeCount;
  const heap = new MinHeap(Math.max(capacity, 1));

  for (const source of sources) {
    if (tiles.resolve(source) === undefined) continue;
    const index = intern(source);
    if (distance[index] !== 0) {
      distance[index] = 0;
      parent[index] = NO_PARENT;
      heap.push(index, 0);
    }
  }

  const out = new Map<number, { cost: number; next: number }>();

  while (!heap.isEmpty()) {
    const currentIndex = heap.pop();
    if (currentIndex < 0) break;
    if (settled[currentIndex]) continue;

    settled[currentIndex] = true;
    const currentId = globalId[currentIndex]!;
    const currentDistance = distance[currentIndex]!;

    // `next` is the step toward the nearest source — the parent pointer, which
    // for a reverse search is the neighbour closer to safety.
    const parentIndex = parent[currentIndex]!;
    out.set(currentId, {
      cost: currentDistance,
      next: parentIndex === NO_PARENT ? currentId : globalId[parentIndex]!,
    });

    for (const edge of tiles.edges(currentId, direction)) {
      const weight = edgeCost ? edgeCost(currentId, edge.target, edge.weight) : edge.weight;
      const candidate = currentDistance + weight;

      const neighbourIndex = intern(edge.target);
      if (settled[neighbourIndex]) continue;

      if (candidate < distance[neighbourIndex]!) {
        distance[neighbourIndex] = candidate;
        parent[neighbourIndex] = currentIndex;
        heap.push(neighbourIndex, candidate);
      }
    }
  }

  return out;
}

function reconstruct(
  parent: readonly number[],
  globalId: readonly number[],
  endIndex: number,
): number[] {
  const reversed: number[] = [];
  for (let index = endIndex; index !== NO_PARENT; index = parent[index]!) {
    reversed.push(globalId[index]!);
  }
  return reversed.reverse();
}
