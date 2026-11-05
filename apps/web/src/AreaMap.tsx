import { LocateFixed } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { roadPaths } from './mapPaths';
import { NavigationMap } from './NavigationMap';
import type { Bounds, MapDrawing } from "@offgrid/maps";

export const VectorMap = memo(function VectorMap({ drawing, compact = false, position }: { drawing: MapDrawing; compact?: boolean; position?: [number, number] | undefined }) {
  const id = useId().replaceAll(":", "");
  const element = useRef<SVGSVGElement>(null);
  const [scale, setScale] = useState(.6);
  useEffect(() => {
    if (compact || !element.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(Math.max(.1, Math.min(entry.contentRect.width / 1000, entry.contentRect.height / 700)));
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [compact]);
  const [w, s, e, n] = drawing.bounds;
  const cos = Math.cos((n + s) / 2 * Math.PI / 180);
  const ratio = (e - w) * cos / (n - s);
  const height = Math.min(500, 730 / ratio);
  const width = height * ratio;
  const left = (1000 - width) / 2;
  const top = (700 - height) / 2;
  const project = ([lon, lat]: readonly number[]) => [left + (lon! - w) / (e - w) * width, top + (n - lat!) / (n - s) * height];
  const path = (points: Array<[number, number]>) => points.map((point, i) => { const [x, y] = project(point); return `${i ? "L" : "M"}${x!.toFixed(1)},${y!.toFixed(1)}`; }).join(" ");
  const roads = compact ? drawing.roads.filter((r) => !["service", "steps", "footway", "path"].includes(r.kind)).slice(0, 180) : drawing.roads;
  const grouped = useMemo(() => roadPaths(roads, point => { const p = project(point); return [p[0]!, p[1]!]; }), [drawing, compact]);
  const pin = position ? project(position) : null;
  // SVG font units scale with the viewBox. Preserve a readable 12px display
  // size and omit colliding labels rather than piling tiny text on the map.
  const fontSize = 12 / scale;
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  const labels = compact ? [] : drawing.labels.filter((label) => {
    const [x, y] = project(label.point);
    const width = label.text.length * fontSize * .56 + 8 / scale;
    const box = { x: x! - width / 2, y: y! - fontSize, width, height: fontSize * 1.5 };
    if (box.x < 8 || box.x + width > 992 || box.y < 8 || box.y + box.height > 692) return false;
    if (boxes.some((other) => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y)) return false;
    boxes.push(box);
    return true;
  });
  return <svg ref={element} className="vector-map" viewBox="0 0 1000 700" role={compact ? undefined : "img"} aria-hidden={compact || undefined} aria-label={compact ? undefined : "Street map showing the exact download boundary. Coverage is also described in the area details."}>
    <defs>
      <pattern id={`grid-${id}`} width="70" height="70" patternUnits="userSpaceOnUse"><path d="M70 0H0V70" fill="none" stroke="currentColor" strokeWidth="0.6" /></pattern>
      <clipPath id={`clip-${id}`}><rect x="0" y="0" width="1000" height="700" /></clipPath>
    </defs>
    <rect width="1000" height="700" className="map-ground" />
    {!compact && <rect width="1000" height="700" fill={`url(#grid-${id})`} className="map-grid" />}
    <g clipPath={`url(#clip-${id})`}>
      <rect x={left} y={top} width={width} height={height} className="coverage-fill" />
      {grouped.map(([kind, d]) => <path key={`c${kind}`} d={d} className={`road-casing road-${kind}`} />)}
      {grouped.map(([kind, d]) => <path key={kind} d={d} className={`road-line road-${kind}`} />)}
      {labels.map((label, i) => { const [x, y] = project(label.point); return <text key={i} x={x} y={y} style={{ fontSize }} className="map-label" textAnchor="middle">{label.text}</text>; })}
      <rect x={left} y={top} width={width} height={height} className="coverage-boundary" />
      {!compact && [[left, top], [left + width, top], [left, top + height], [left + width, top + height]].map(([x, y], i) => <rect key={i} x={x! - 4} y={y! - 4} width="8" height="8" rx="1" className="boundary-corner" />)}
      {pin && <g transform={`translate(${pin[0]},${pin[1]})`}><circle r="20" className="position-halo"/><circle r="7" className="position-dot"/></g>}
    </g>
  </svg>;
});

export function AreaMap({ drawing, title, coverage, position, installed }: { drawing: MapDrawing; title: string; coverage: string; position?: [number, number] | undefined; installed: boolean }) {
  const bounds: Bounds = drawing.bounds;
  const latitude = (bounds[1] + bounds[3]) / 2;
  const longitude = (bounds[0] + bounds[2]) / 2;
  return <section className="map-panel" aria-label={`${title} coverage preview`}>
    <div className="map-caption"><span className="map-caption-marker"/><span>{installed ? "Your offline map" : "Download coverage"}</span><span className="map-caption-place">{title}</span></div>
    <div className="map-viewport"><NavigationMap drawing={drawing} position={position} preview/></div>
    <div className="map-compass" aria-hidden="true"><span>N</span><svg viewBox="0 0 28 36"><path d="M14 2 25 32 14 25 3 32Z" fill="currentColor"/><path d="M14 2v23L3 32Z" fill="var(--paper)"/></svg></div>
    <div className="coverage-key"><span/><div><strong>{coverage}</strong><p>The outline shows this pack’s coverage.</p></div></div>
    <div className="map-footer"><span><LocateFixed size={12}/>{latitude.toFixed(4)}° N · {longitude.toFixed(4)}° E</span><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></div>
  </section>;
}
