/**
 * Bidirectional A* — the production router.
 *
 * Two searches run at once: forward from the source, backward from the target
 * over the reverse graph. They meet in the middle, which explores far less of
 * the graph than a single search sweeping outward.
 *
 * Two things about this are easy to get wrong, and both produce routes that
 * look perfectly reasonable while being quietly suboptimal:
 *
 * **Balanced potentials.** The obvious approach gives the forward search a
 * heuristic aimed at the target and the backward search one aimed at the
 * source. Each is individually admissible, but together they optimise
 * *inconsistent* objectives — the two searches disagree about what "cheap"
 * means, so where they meet is not where the shortest path crosses. The fix is
 * to make the potentials sum to zero everywhere:
 *
 *     p_f(v) = (h_f(v) - h_b(v)) / 2
 *     p_b(v) = -p_f(v)
 *
 * Roughly half the heuristic strength of one-directional A*, and correct.
 *
 * **Termination.** Stopping when the frontiers first touch is wrong: the first
 * node both searches reach is usually *not* on the optimal path. Instead track
 * `mu`, the best complete path cost seen so far, and stop only when
 * `topF + topB >= mu` — at which point no unexplored path can beat it.
 *
 * Verified against `dijkstra-reference.ts` over thousands of random pairs. If
 * they ever disagree, this file is wrong.
 */

import { heuristicWeight } from "../geo/distance.js";
import { WEIGHT_SCALE } from "../graph/format.js";
import type { TileSet } from "../graph/tileset.js";
import { MinHeap } from "./heap.js";

const NO_PARENT = -1;

export interface RouteResult {
  /** Total path cost in the integer weight units of format.ts. */
  readonly cost: number;
  /** Global node ids from source to target inclusive. */
  readonly path: readonly number[];
  /** Nodes settled across both searches — the measure of search effort. */
  readonly settled: number;
  /**
   * Cells the search reached the edge of but could not enter.
   *
   * Non-empty does **not** mean the route is wrong: a search often touches a
   * boundary into territory it had no reason to explore. It means a better
   * route might exist through those cells — load them and run again to be sure.
   *
   * When no route was found at all, `cost` is Infinity and `path` is empty.
   */
  readonly missing: readonly string[];
}

export interface RouteOptions {
  /**
   * Per-edge cost multiplier. This is how hazards enter routing: a reported
   * barricade scales nearby edges rather than deleting them.
   *
   * Must never *lower* a weight below the raw value. The heuristic assumes
   * edges cost at least their stored weight, so a discount breaks admissibility
   * and the router starts returning suboptimal routes.
   */
  readonly edgeCost?: (source: number, target: number, weight: number) => number;

  /** Abandon the search after this many settled nodes. Unlimited by default. */
  readonly maxSettled?: number;
}

/** Per-direction search state. Two of these run in lockstep. */
interface SearchState {
  readonly heap: MinHeap;
  readonly distance: number[];
  readonly parent: number[];
  readonly settled: boolean[];
}

/**
 * Shortest path from `source` to `target`, or undefined when none exists.
 *
 * Every tile the path might touch should already be loaded; the result's
 * `missing` field reports cells the search wanted but could not reach.
 */
export function route(
  tiles: TileSet,
  source: number,
  target: number,
  options: RouteOptions = {},
): RouteResult | undefined {
  if (tiles.resolve(source) === undefined) return undefined;
  if (tiles.resolve(target) === undefined) return undefined;

  if (source === target) {
    return { cost: 0, path: [source], settled: 0, missing: [] };
  }

  // Different components means no path at all — an O(1) answer instead of
  // exhausting everything reachable before admitting defeat.
  const sourceComponent = tiles.component(source);
  const targetComponent = tiles.component(target);
  if (sourceComponent >= 0 && targetComponent >= 0 && sourceComponent !== targetComponent) {
    return undefined;
  }

  const sourcePos = tiles.position(source);
  const targetPos = tiles.position(target);
  if (!sourcePos || !targetPos) return undefined;

  const edgeCost = options.edgeCost;
  const maxSettled = options.maxSettled ?? Number.POSITIVE_INFINITY;

  // Global ids are sparse; searches index by dense slot assigned on first sight.
  const indexOf = new Map<number, number>();
  const globalId: number[] = [];
  const missing = new Set<string>();

  let capacity = 0;
  for (const geohash of tiles.loaded) capacity += tiles.get(geohash)!.nodeCount;
  capacity = Math.max(capacity, 2);

  const makeState = (): SearchState => ({
    heap: new MinHeap(capacity),
    distance: [],
    parent: [],
    settled: [],
  });

  const forward = makeState();
  const backward = makeState();

  const intern = (id: number): number => {
    let index = indexOf.get(id);
    if (index === undefined) {
      index = globalId.length;
      indexOf.set(id, index);
      globalId.push(id);
      for (const state of [forward, backward]) {
        state.distance.push(Number.POSITIVE_INFINITY);
        state.parent.push(NO_PARENT);
        state.settled.push(false);
      }
    }
    return index;
  };

  /**
   * Balanced potential at a node, **doubled** to stay an integer.
   *
   * The true potential is `(h_f - h_b) / 2`, which is a half-integer. Rounding
   * it into the heap key perturbs every key by up to 0.5, and since the
   * termination test sums two keys, the bound can read up to a full unit low
   * and stop before the optimum is confirmed -- which showed up as routes a few
   * percent *dearer* than the reference implementation, never cheaper.
   *
   * Working in doubled units keeps the arithmetic exact. Distances are doubled
   * to match, and the factor is divided back out of the termination test.
   *
   * `p_f + p_b == 0` by construction, which is what keeps the two searches
   * consistent with one another.
   */
  const doublePotential = (id: number): number => {
    const position = tiles.position(id);
    if (!position) return 0;
    const toTarget = heuristicWeight(
      position.lat,
      position.lon,
      targetPos.lat,
      targetPos.lon,
      WEIGHT_SCALE,
    );
    const fromSource = heuristicWeight(
      sourcePos.lat,
      sourcePos.lon,
      position.lat,
      position.lon,
      WEIGHT_SCALE,
    );
    return toTarget - fromSource;
  };

  const sourceIndex = intern(source);
  const targetIndex = intern(target);

  forward.distance[sourceIndex] = 0;
  backward.distance[targetIndex] = 0;

  // Heap keys must be non-negative integers (MinHeap is Uint32-backed), but a
  // doubled potential can be negative -- as low as -h(source, target). Offset
  // every key by that bound so the sum is never negative.
  //
  // Clamping at zero instead would be a silent correctness bug: it maps
  // distinct keys onto the same value, so the heap pops out of order and
  // peekPriority under-reports the frontier, breaking the termination test.
  const keyOffset = Math.ceil(
    Math.abs(
      heuristicWeight(sourcePos.lat, sourcePos.lon, targetPos.lat, targetPos.lon, WEIGHT_SCALE),
    ),
  );

  /** Key in doubled units: 2*distance + doubledPotential + offset. */
  const toKey = (distance: number, id: number): number => {
    const key = 2 * distance + doublePotential(id) + keyOffset;
    if (key < 0) {
      // The offset is meant to make this impossible. If it ever fires, the
      // bound above is wrong -- fail loudly rather than clamping and silently
      // returning suboptimal routes.
      throw new Error(`negative heap key ${key}: keyOffset ${keyOffset} is too small`);
    }
    return key;
  };

  forward.heap.push(sourceIndex, toKey(0, source));
  backward.heap.push(targetIndex, toKey(0, target));

  /** Best complete path cost found so far. */
  let mu = Number.POSITIVE_INFINITY;
  let meetingIndex = -1;
  let settledCount = 0;

  /**
   * When the best join was found mid-relaxation, the meeting node's parent link
   * in that tree may describe a different (cheaper) route than the one `mu`
   * measures. These record the true predecessor for that join so the path can
   * be stitched from the same route the cost came from.
   */
  let meetingSide: SearchState | undefined;
  let meetingPredecessor = NO_PARENT;

  const expand = (
    state: SearchState,
    other: SearchState,
    direction: "forward" | "reverse",
  ): boolean => {
    const currentIndex = state.heap.pop();
    if (currentIndex < 0) return false;
    if (state.settled[currentIndex]) return true;

    state.settled[currentIndex] = true;
    settledCount++;

    const currentId = globalId[currentIndex]!;
    const currentDistance = state.distance[currentIndex]!;

    // A node with no adjacency here belongs to a tile that is not loaded.
    // Record it so the caller knows what to fetch, and carry on — other
    // branches may still reach the target.
    const unresolved = tiles.unresolved(currentId);
    if (unresolved) missing.add(unresolved.geohash);

    for (const edge of tiles.edges(currentId, direction)) {
      const weight = edgeCost ? edgeCost(currentId, edge.target, edge.weight) : edge.weight;
      const candidate = currentDistance + weight;

      const neighbourIndex = intern(edge.target);
      if (state.settled[neighbourIndex]) continue;

      if (candidate < state.distance[neighbourIndex]!) {
        state.distance[neighbourIndex] = candidate;
        state.parent[neighbourIndex] = currentIndex;
        state.heap.push(neighbourIndex, toKey(candidate, edge.target));
      }

      // Join through this neighbour if the opposite search has already settled
      // it. This check cannot be dropped in favour of only joining at settled
      // nodes: the optimal path's meeting point is often discovered *here* and
      // never popped by both sides before the termination bound fires.
      //
      // The subtlety is that `candidate` is tentative -- if the relaxation
      // guard above failed, `parent[neighbourIndex]` still points along an
      // earlier, cheaper route that does not cost `candidate`. Pairing that
      // cost with that parent chain is what produced routes cheaper than the
      // true optimum containing a step with no edge behind it. So record the
      // predecessor that belongs to *this* join explicitly, and let joinPaths
      // use it instead of trusting the tree link.
      if (other.settled[neighbourIndex]) {
        const total = candidate + other.distance[neighbourIndex]!;
        if (total < mu) {
          mu = total;
          meetingIndex = neighbourIndex;
          meetingSide = state;
          meetingPredecessor = currentIndex;
        }
      }
    }

    // The node just settled may itself be the join point, in which case its own
    // committed parent chain is correct and no override is needed.
    if (other.settled[currentIndex]) {
      const total = currentDistance + other.distance[currentIndex]!;
      if (total < mu) {
        mu = total;
        meetingIndex = currentIndex;
        meetingSide = undefined;
        meetingPredecessor = NO_PARENT;
      }
    }

    return true;
  };

  while (!forward.heap.isEmpty() && !backward.heap.isEmpty()) {
    if (settledCount >= maxSettled) break;

    const topF = forward.heap.peekPriority()!;
    const topB = backward.heap.peekPriority()!;

    // The termination bound, in doubled units. Each key carries the offset, so
    // both are subtracted out; the remaining sum is 2*(real path cost), which
    // is compared against 2*mu rather than dividing and losing the exactness
    // the doubling was introduced to preserve.
    if (topF + topB - 2 * keyOffset >= 2 * mu) break;

    // Expand whichever side is cheaper to advance — keeps the frontiers
    // balanced when one direction branches more than the other.
    if (topF <= topB) {
      if (!expand(forward, backward, "forward")) break;
    } else {
      if (!expand(backward, forward, "reverse")) break;
    }
  }

  // A search can touch halo nodes pointing into unloaded tiles and *still* find
  // a complete path — the missing tiles simply held routes it did not need.
  // So `missing` is reported as advice, never as a reason to discard a result.
  if (meetingIndex >= 0 && Number.isFinite(mu)) {
    return {
      cost: mu,
      path: joinPaths(
        forward,
        backward,
        globalId,
        meetingIndex,
        meetingSide,
        meetingPredecessor,
      ),
      settled: settledCount,
      missing: [...missing],
    };
  }

  // No path found. If tiles were wanted, say so: the caller can load them and
  // retry. Returning a zero-cost empty route here would read as free travel.
  if (missing.size > 0) {
    return {
      cost: Number.POSITIVE_INFINITY,
      path: [],
      settled: settledCount,
      missing: [...missing],
    };
  }

  return undefined;
}

/**
 * Stitch the two half-paths at the meeting node.
 *
 * The forward half runs source -> meeting and needs reversing; the backward
 * half already runs meeting -> target because its parent pointers were built
 * walking backward from the target.
 */
function joinPaths(
  forward: SearchState,
  backward: SearchState,
  globalId: readonly number[],
  meetingIndex: number,
  meetingSide?: SearchState,
  meetingPredecessor: number = NO_PARENT,
): number[] {
  // A mid-relaxation join reached the meeting node from `meetingPredecessor`,
  // which is not necessarily what the tree link says. Walk that side's chain
  // from the predecessor instead, so the stitched path matches the cost in mu.
  const parentOf = (state: SearchState, index: number): number =>
    state === meetingSide && index === meetingIndex ? meetingPredecessor : state.parent[index]!;

  // Forward tree: parent[v] is the node before v on the way from the source,
  // so walking parents from the meeting node and reversing gives
  // source -> ... -> meeting.
  const head: number[] = [];
  for (let index = meetingIndex; index !== NO_PARENT; index = parentOf(forward, index)) {
    head.push(globalId[index]!);
  }
  head.reverse();

  // Backward tree: built by exploring reverse edges out of the target, so
  // parent[v] is the node *after* v on the way to the target. Walking parents
  // from the meeting node therefore already runs meeting -> ... -> target, and
  // each consecutive pair is a forward-traversable edge. The meeting node is
  // already in `head`, so start from its parent.
  const tail: number[] = [];
  for (
    let index = parentOf(backward, meetingIndex);
    index !== NO_PARENT;
    index = backward.parent[index]!
  ) {
    tail.push(globalId[index]!);
  }

  return [...head, ...tail];
}
