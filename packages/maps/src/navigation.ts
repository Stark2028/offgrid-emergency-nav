import { haversineMetres, route, TileSet, WEIGHT_SCALE, type RoutingGraph } from '@offgrid/core';
import { contains, type Bounds } from './manifest.js';

/** WGS84 longitude, latitude. Positions never leave the device. */
export type Point = [number, number];
export interface RoadEdge { source: number; target: number; weight: number; points: Point[]; lengths: number[]; metres: number }
export interface Projection { point: Point; distance: number; along: number; segment: number; fraction: number }
export interface WalkingRoute {
  points: Point[];
  metres: number;
  seconds: number;
  start: Point;
  destination: Point;
  startOffset: number;
  destinationOffset: number;
}
export function distance(a: Point, b: Point): number { return haversineMetres(a[1], a[0], b[1], b[0]); }
export function lineLengths(points: Point[]): number[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + distance(points[i - 1]!, points[i]!));
  return lengths;
}
function valid(point: Point) {
  if (!point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new Error('Choose a valid point on the map.');
}
/** Projection in a local tangent plane, with travelled distances in metres. */
export function projectOnLine(point: Point, points: Point[], lengths = lineLengths(points)): Projection {
  valid(point);
  let best: Projection | undefined;
  const cos = Math.cos(point[1] * Math.PI / 180);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const x = (b[0] - a[0]) * cos, y = b[1] - a[1];
    const t = x || y ? Math.max(0, Math.min(1, (((point[0] - a[0]) * cos) * x + (point[1] - a[1]) * y) / (x * x + y * y))) : 0;
    const snapped: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const d = distance(point, snapped);
    if (!best || d < best.distance) best = { point: snapped, distance: d, along: lengths[i - 1]! + t * (lengths[i]! - lengths[i - 1]!), segment: i - 1, fraction: t };
  }
  if (!best) throw new Error('This map has no usable path geometry.');
  return best;
}
function slice(edge: RoadEdge, start: Projection, end?: Projection): Point[] {
  return [start.point, ...edge.points.slice(start.segment + 1, end ? end.segment + 1 : undefined), ...(end ? [end.point] : [])];
}
function append(to: Point[], points: Point[]) { for (const p of points) if (!to.length || distance(to[to.length - 1]!, p) > .01) to.push(p); }

/** Uses the proven core router between directed edge-interior connections.
 * Parallel roads retain their actual shape; there are no straight shortcuts
 * between a dropped pin and an arbitrary nearest junction.
 */
export class WalkingNetwork {
  readonly edges: RoadEdge[] = [];
  private readonly outgoing = new Map<number, RoadEdge[]>();
  private readonly graph: RoutingGraph;
  constructor(readonly tiles: TileSet, private readonly bounds?: Bounds) {
    const allowed = new Map<string, boolean>();
    this.graph = bounds ? {
      loaded: tiles.loaded, get: tiles.get.bind(tiles), resolve: tiles.resolve.bind(tiles),
      position: tiles.position.bind(tiles), component: tiles.component.bind(tiles), unresolved: tiles.unresolved.bind(tiles),
      *edges(id, direction) {
        const ref = tiles.resolve(id); if (!ref || ref.halo) return;
        const origin = tiles.position(id)!;
        if (!contains(bounds, origin.lat, origin.lon)) return;
        for (const edge of tiles.edges(id, direction)) {
          const key = `${direction}:${id}:${edge.target}:${edge.weight}:${edge.geometry}`;
          let valid = allowed.get(key);
          if (valid === undefined) {
            const target = tiles.position(edge.target), shape = ref.tile.edgeGeometry(edge.geometry);
            valid = !!target && contains(bounds, target.lat, target.lon);
            for (let i = 0; valid && i < shape.lat.length; i++) valid = contains(bounds, shape.lat[i]!, shape.lon[i]!);
            allowed.set(key, valid);
          }
          if (valid) yield edge;
        }
      },
    } : tiles;
    for (const cell of tiles.loaded) {
      const tile = tiles.get(cell)!;
      for (let slot = 0; slot < tile.nodeCount; slot++) {
        if (tile.isHalo(slot)) continue;
        const source = tile.globalIds[slot]!;
        for (let i = tile.fwdOffset[slot]!; i < tile.fwdOffset[slot + 1]!; i++) {
          const targetSlot = tile.fwdTarget[i]!, target = tile.globalIds[targetSlot]!;
          const shape = tile.edgeGeometry(tile.fwdGeometry[i]!);
          const points: Point[] = [[tile.lon[slot]!, tile.lat[slot]!]];
          for (let p = 0; p < shape.lat.length; p++) points.push([shape.lon[p]!, shape.lat[p]!]);
          points.push([tile.lon[targetSlot]!, tile.lat[targetSlot]!]);
          if (bounds && points.some(([lon, lat]) => !contains(bounds, lat, lon))) continue;
          const lengths = lineLengths(points), metres = lengths[lengths.length - 1]!;
          const edge = { source, target, weight: tile.fwdWeight[i]!, points, lengths, metres };
          this.edges.push(edge);
          const list = this.outgoing.get(source) ?? []; list.push(edge); this.outgoing.set(source, list);
        }
      }
    }
    if (!this.edges.length) throw new Error('No walking paths were found in this map.');
  }
  private snaps(point: Point) {
    valid(point);
    if (this.bounds && !contains(this.bounds, point[1], point[0])) throw new Error('Choose a point inside this saved area.');
    const projections = this.edges.map(edge => ({ edge, projection: projectOnLine(point, edge.points, edge.lengths) }));
    const nearest = projections.reduce((best, p) => Math.min(best, p.projection.distance), Infinity);
    if (nearest > 75) throw new Error('That point is more than 75 m from a mapped walking path. Choose a nearby path or entrance.');
    // Retain both travel directions and edges meeting at the same junction.
    // Never connect separate parallel roads merely because they are nearby.
    const candidates = projections.filter(p => p.projection.distance <= nearest + .05);
    if (candidates.length > 24) throw new Error('Several paths overlap here. Choose a clearer point on a path.');
    const parent = new Map<number, number>();
    const root = (id: number): number => { const p = parent.get(id); return p === undefined ? id : root(p); };
    for (const { edge } of candidates) if (edge.metres < .1 && root(edge.source) !== root(edge.target)) parent.set(root(edge.target), root(edge.source));
    const physical = new Set(candidates.map(({ edge, projection }) => {
      if (projection.along < .1) return `node:${root(edge.source)}`;
      if (edge.metres - projection.along < .1) return `node:${root(edge.target)}`;
      const forward = JSON.stringify(edge.points), reverse = JSON.stringify(edge.points.slice().reverse());
      const shape = edge.source === edge.target ? (forward < reverse ? forward : reverse) : edge.source < edge.target ? forward : reverse;
      return `edge:${Math.min(edge.source, edge.target)}:${Math.max(edge.source, edge.target)}:${shape}`;
    }));
    if (physical.size > 1) {
      // A finger/GPS fix just beside a real junction can project a few
      // centimetres along one incident edge and onto the endpoint of another.
      // Resolve only a shared graph node within 2m; coordinate coincidence at
      // an unconnected overpass never supplies a shared node.
      let common: Set<number> | undefined;
      for (const { edge, projection } of candidates) {
        const near = new Set<number>();
        if (projection.along <= 2 && distance(point, edge.points[0]!) <= 75) near.add(root(edge.source));
        if (edge.metres - projection.along <= 2 && distance(point, edge.points[edge.points.length - 1]!) <= 75) near.add(root(edge.target));
        common = common === undefined ? near : new Set([...common].filter(id => near.has(id)));
      }
      if (common?.size) {
        const junction = [...common].reduce((a, b) => {
          const pa = this.tiles.position(a)!, pb = this.tiles.position(b)!;
          return distance(point, [pa.lon, pa.lat]) <= distance(point, [pb.lon, pb.lat]) ? a : b;
        });
        return candidates.map(({ edge, projection }) => {
          const atStart = root(edge.source) === junction && projection.along <= 2;
          const snapped = edge.points[atStart ? 0 : edge.points.length - 1]!;
          return { edge, projection: { point: snapped, distance: distance(point, snapped), along: atStart ? 0 : edge.metres, segment: atStart ? 0 : edge.points.length - 2, fraction: atStart ? 0 : 1 } };
        });
      }
      throw new Error('Several mapped paths overlap here. Choose a point farther along the path or another entrance.');
    }
    return candidates;
  }
  plan(start: Point, destination: Point): WalkingRoute {
    const starts = this.snaps(start), ends = this.snaps(destination);
    let best: { cost: number; points: Point[]; a: typeof starts[number]; b: typeof ends[number] } | undefined;
    const cache = new Map<string, ReturnType<typeof route>>();
    for (const a of starts) for (const b of ends) {
      const firstRatio = a.edge.metres ? a.projection.along / a.edge.metres : 0;
      const lastRatio = b.edge.metres ? b.projection.along / b.edge.metres : 0;
      if (a.edge === b.edge && firstRatio <= lastRatio) {
        const cost = a.edge.weight * (lastRatio - firstRatio);
        if (!best || cost < best.cost) best = { cost, points: slice(a.edge, a.projection, b.projection), a, b };
      }
      // At an exact endpoint there is no need to traverse a full extra edge.
      const from = a.projection.along < .01 ? a.edge.source : a.edge.target;
      const to = b.edge.metres - b.projection.along < .01 ? b.edge.target : b.edge.source;
      const key = `${from}:${to}`;
      if (!cache.has(key)) cache.set(key, route(this.graph, from, to, { maxSettled: 200000 }));
      const middle = cache.get(key);
      if (middle && middle.status !== 'complete') throw new Error('This route needs more map coverage or exceeds this device\'s search limit. Choose closer points within the saved area.');
      if (!middle || !Number.isFinite(middle.cost)) continue;
      const firstCost = from === a.edge.source ? 0 : a.edge.weight * (1 - firstRatio);
      const lastCost = to === b.edge.target ? 0 : b.edge.weight * lastRatio;
      const cost = firstCost + middle.cost + lastCost;
      if (best && cost >= best.cost) continue;
      const points: Point[] = [];
      append(points, from === a.edge.source ? [a.projection.point] : slice(a.edge, a.projection));
      for (let i = 1; i < middle.path.length; i++) {
        // There is no hazard overlay in this walking release. The core chooses
        // the minimum base weight between each node pair. Preserve that exact
        // edge's geometry even when another road shares the same endpoints.
        const edges = this.outgoing.get(middle.path[i - 1]!)?.filter(e => e.target === middle.path[i]);
        const edge = edges?.reduce((a, b) => a.weight <= b.weight ? a : b);
        if (!edge) throw new Error('The route geometry is incomplete. Check the saved map files.');
        append(points, edge.points);
      }
      append(points, to === b.edge.target ? [b.projection.point] : [b.edge.points[0]!, ...b.edge.points.slice(1, b.projection.segment + 1), b.projection.point]);
      best = { cost, points, a, b };
    }
    if (!best) throw new Error('No complete walking route connects these points within this saved area. Try another entrance or a larger map.');
    const points = best.points;
    const lengths = lineLengths(points);
    if (points.length < 2 || lengths[lengths.length - 1]! < 3) throw new Error('These points are already together. Choose a destination farther away.');
    return { points, metres: lengths[lengths.length - 1]!, seconds: best.cost / WEIGHT_SCALE, start: best.a.projection.point, destination: best.b.projection.point, startOffset: best.a.projection.distance, destinationOffset: best.b.projection.distance };
  }
}
