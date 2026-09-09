/**
 * Geographic distance and the A* heuristic derived from it.
 *
 * Admissibility is the whole game here: if the heuristic ever *overestimates*
 * the true remaining cost, A* silently returns suboptimal paths and no test
 * that only checks "a route came back" will catch it. Every rounding decision
 * below is therefore biased toward underestimating.
 */

/** Earth radius, metres. Mean spherical radius (IUGG). */
const EARTH_RADIUS_M = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than equirectangular: the flat approximation is cheaper but
 * overestimates at Delhi's latitude by enough to break admissibility on long
 * east-west routes, and "cheaper" is meaningless if the answer is wrong.
 */
export function haversineMetres(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const phiA = latA * DEG_TO_RAD;
  const phiB = latB * DEG_TO_RAD;
  const dPhi = (latB - latA) * DEG_TO_RAD;
  const dLambda = (lonB - lonA) * DEG_TO_RAD;

  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);

  const a =
    sinDPhi * sinDPhi + Math.cos(phiA) * Math.cos(phiB) * sinDLambda * sinDLambda;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Fastest speed any edge in the graph may claim, metres/second.
 *
 * The heuristic divides straight-line distance by this to get a lower bound on
 * travel time. It must be >= the speed of the fastest edge the pipeline emits,
 * or the bound is not a bound. The pipeline asserts this invariant when it
 * writes tiles (see build_graph.py), so the two constants cannot drift apart.
 *
 * 33.34 m/s = 120 km/h, above any signed limit on Delhi's network.
 */
export const MAX_SPEED_MPS = 33.34;

/**
 * Admissible time-to-target estimate, in the integer weight units of format.ts.
 *
 * Floored, not rounded: flooring can only shrink the estimate, and a heuristic
 * that is slightly too small costs a few extra node expansions, whereas one
 * that is slightly too large costs correctness.
 */
export function heuristicWeight(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
  weightScale: number,
): number {
  const metres = haversineMetres(latA, lonA, latB, lonB);
  return Math.floor((metres / MAX_SPEED_MPS) * weightScale);
}
