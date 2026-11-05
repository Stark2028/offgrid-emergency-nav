import { describe, it, expect } from 'vitest';
import { Tile, TileSet, dijkstra } from '@offgrid/core';
import { WalkingNetwork, distance, lineLengths, projectOnLine, type Point } from '../src/navigation.js';
import fixtures from './navigation-fixtures.json' with { type: 'json' };

function network(name: keyof typeof fixtures) {
  const tiles = new TileSet();
  for (const base64 of Object.values(fixtures[name].tiles)) {
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    tiles.add(new Tile(bytes.buffer));
  }
  return new WalkingNetwork(tiles);
}
function at(a: Point, b: Point, fraction: number): Point { return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]; }
describe('walking navigation on directed edge interiors', () => {
  it('routes between midpoints without visiting the end junctions', () => {
    const n = network('oneway'), e = n.edges[0]!;
    const result = n.plan(at(e.points[0]!,e.points[1]!,.25),at(e.points[0]!,e.points[1]!,.75));
    expect(result.metres).toBeCloseTo(e.metres / 2, 3);
    expect(result.seconds).toBeCloseTo(e.weight / 200, 5);
    expect(result.points).toHaveLength(2);
  });
  it('does not route backwards along a one-way walking edge', () => {
    const n = network('oneway'), e = n.edges[0]!;
    expect(() => n.plan(at(e.points[0]!,e.points[1]!,.75),at(e.points[0]!,e.points[1]!,.25))).toThrow('No complete walking route');
  });
  it('preserves bends and can travel in either direction on a two-way path', () => {
    const n = network('curved'), e = n.edges[0]!;
    const first = at(e.points[0]!,e.points[1]!,.4), last = at(e.points[e.points.length-2]!,e.points[e.points.length-1]!,.6);
    const forward = n.plan(first,last), reverse = n.plan(last,first);
    expect(forward.points.length).toBeGreaterThan(2);
    expect(forward.metres).toBeCloseTo(reverse.metres, 2);
    expect(forward.points[1]).toEqual(e.points[1]);
    expect(distance(reverse.points[0]!,last)).toBeLessThan(.1);
  });
  it('uses the cheapest parallel edge geometry, matching the reference oracle', () => {
    const n = network('parallel');
    const from: Point = [Math.fround(77.2),Math.fround(28.6)], to: Point=[Math.fround(77.204),Math.fround(28.6)];
    const result = n.plan(from,to);
    expect(result.points.every(p=>Math.abs(p[1]-from[1])<.00001)).toBe(true);
    const source=n.edges.find(e=>distance(e.points[0]!,from)<.1)!.source;
    const target=n.edges.find(e=>distance(e.points[e.points.length-1]!,to)<.1)!.target;
    expect(result.seconds*100).toBeCloseTo(dijkstra(n.tiles,source,target)!.cost,2);
  });
  it('reports disconnected coverage instead of drawing a straight line', () => {
    expect(()=>network('islands').plan([77.201,28.6],[77.201,28.602])).toThrow('No complete walking route');
  });
  it('rejects distant pins, identical destinations, and non-finite coordinates', () => {
    const n=network('curved');
    expect(()=>n.plan([77,28],[77.2,28.6])).toThrow('75 m');
    expect(()=>n.plan([77.2,28.6],[77.2,28.6])).toThrow('already together');
    expect(()=>n.plan([NaN,28],[77.2,28.6])).toThrow('valid point');
  });
  it('projects progress onto a bent route using distance along the route', () => {
    const points: Point[]=[[77.2,28.6],[77.201,28.6],[77.201,28.601]];
    const lengths=lineLengths(points), p=projectOnLine([77.201,28.6005],points,lengths);
    expect(p.distance).toBeLessThan(.1);
    expect(p.along).toBeCloseTo(lengths[1]!+(lengths[2]!-lengths[1]!)/2,2);
  });
  it('chooses a longer covered path instead of a faster excursion beyond the download boundary', () => {
    const whole=network('bounded');
    const bounds=[77.1999,28.5998,77.2021,28.6001] as const;
    const covered=new WalkingNetwork(whole.tiles,bounds);
    const from: Point=[Math.fround(77.2),Math.fround(28.6)],to: Point=[Math.fround(77.202),Math.fround(28.6)];
    const fast=whole.plan(from,to),within=covered.plan(from,to);
    expect(within.seconds).toBeGreaterThan(fast.seconds);
    expect(within.points.every(p=>p[1]<=bounds[3])).toBe(true);
    expect(()=>covered.plan([77.201,28.601],to)).toThrow('inside this saved area');
  });
  it('does not silently choose a level at an unconnected overlapping crossing', () => {
    const n=network('stacked');
    expect(()=>n.plan([Math.fround(77.201),Math.fround(28.6)],[77.2018,28.6])).toThrow('paths overlap');
  });
  it('resolves a pin just beside a connected junction instead of reporting a false overlap', () => {
    const n=network('parallel'),from: Point=[Math.fround(77.2),Math.fround(28.6)],to: Point=[Math.fround(77.204),Math.fround(28.6)];
    const incident=n.edges.filter(e=>distance(e.points[0]!,from)<.01 && e.points[1]![1]>=from[1]);
    const directions=incident.slice(0,2).map(e=>{const p=e.points[1]!,x=(p[0]-from[0])*Math.cos(from[1]*Math.PI/180),y=p[1]-from[1],length=Math.hypot(x,y);return [x/length,y/length];});
    const x=directions[0]![0]!+directions[1]![0]!,y=directions[0]![1]!+directions[1]![1]!,length=Math.hypot(x,y);
    const pin: Point=[from[0]+x/length/111195/Math.cos(from[1]*Math.PI/180),from[1]+y/length/111195];
    const result=n.plan(pin,to);
    expect(distance(result.start,from)).toBeLessThan(.01);
    expect(result.startOffset).toBeCloseTo(1,2);
    expect(result.metres).toBeCloseTo(n.plan(from,to).metres,2);
  });
});
