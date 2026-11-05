import type { MapDrawing, Point } from '@offgrid/maps';

/** One SVG path per road class keeps city maps out of the 40,000-DOM-node range. */
export function roadPaths(roads: MapDrawing['roads'], project: (point: Point) => Point): Array<[string, string]> {
  const groups = new Map<string, string[]>();
  for (const road of roads) {
    const d = road.points.map((point, i) => { const [x, y] = project(point); return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`; }).join(' ');
    const group = groups.get(road.kind) ?? []; group.push(d); groups.set(road.kind, group);
  }
  return [...groups].map(([kind, paths]) => [kind, paths.join(' ')]);
}
