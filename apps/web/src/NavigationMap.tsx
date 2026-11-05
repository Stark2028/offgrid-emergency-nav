import { useEffect, useRef, useState } from 'react';
import { Map as GLMap, Marker, setWorkerUrl, setWorkerCount, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { LocateFixed, Minus, Plus, RotateCcw } from 'lucide-react';
import type { MapDrawing, Point } from '@offgrid/maps';
import { emptyFeatures, offlineStyle, routeData } from './mapStyle';

setWorkerUrl(workerUrl);
setWorkerCount(2);
interface Props {
  drawing: MapDrawing; start?: Point | undefined; destination?: Point | undefined;
  position?: Point | undefined; route?: Point[] | undefined; onPick?(point: Point): void; preview?: boolean;
}

export function NavigationMap(props: Props) {
  const { drawing, start, destination, position, route, preview = false } = props;
  const container = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null);
  const map = useRef<GLMap | undefined>(undefined), latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(false), [failure, setFailure] = useState(false), [attempt, setAttempt] = useState(0);
  const fitArea = (instance: GLMap) => {
    const [w,s,e,n] = drawing.bounds;
    instance.setMinZoom(0);
    instance.fitBounds([[w,s],[e,n]], { padding: 20, duration: 0 });
    instance.setMinZoom(Math.max(0, instance.getZoom() - .5));
  };

  useEffect(() => {
    if (!container.current) return;
    setReady(false); setFailure(false);
    let instance: GLMap | undefined;
    let active = true;
    const timeout = window.setTimeout(() => { if (active) setFailure(true); }, 30000);
    try {
      instance = new GLMap({
        container: container.current, style: offlineStyle(drawing),
        attributionControl: false, renderWorldCopies: false, dragRotate: false,
        pitchWithRotate: false, touchPitch: false, scrollZoom: !preview,
        maxZoom: 20, maxTileCacheSize: 48, pixelRatio: Math.min(window.devicePixelRatio, 2),
        canvasContextAttributes: { antialias: false, preserveDrawingBuffer: false },
      });
      const current = instance;
      map.current = current;
      current.touchZoomRotate.disableRotation();
      const canvas = current.getCanvas();
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', preview ? 'Street map showing the exact download boundary. Drag to pan and pinch to zoom.' : 'Offline walking map. Choose a named place below, or tap the map to select a point. Drag to pan and pinch to zoom.');
      current.on('load', () => {
        if (!active) return;
        window.clearTimeout(timeout); fitArea(current);
        setFailure(false); setReady(true);
      });
      current.on('click', event => latest.current.onPick?.([event.lngLat.lng,event.lngLat.lat]));
      current.on('idle', () => {
        if (host.current) host.current.dataset.routeReady = String(!!latest.current.route?.length && current.isSourceLoaded('route') && current.queryRenderedFeatures({ layers: ['walking-route'] }).length > 0);
      });
      current.on('webglcontextlost', () => { if (active) setFailure(true); });
      current.on('webglcontextrestored', () => { if (active) setFailure(false); });
      current.on('error', event => {
        // Surface renderer/worker failures without logging map/location data.
        if (active && (!current.isStyleLoaded() || event.error?.message.includes('worker'))) setFailure(true);
      });
      void document.fonts.load('12px "DM Sans Variable"');
    } catch { setFailure(true); window.clearTimeout(timeout); }
    return () => { active = false; window.clearTimeout(timeout); map.current = undefined; instance?.remove(); };
  }, [drawing, preview, attempt]);

  useEffect(() => {
    const current = map.current;
    if (!ready || !current) return;
    const observer = new ResizeObserver(() => current.resize());
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    const current = map.current;
    if (!ready || !current) return;
    (current.getSource('route') as GeoJSONSource).setData(routeData(route));
    if (host.current) host.current.dataset.routeReady = 'false';
    if (!route?.length) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lon,lat] of route) { w=Math.min(w,lon);e=Math.max(e,lon);s=Math.min(s,lat);n=Math.max(n,lat); }
    const dx = 75 / (111195 * Math.cos((s+n)/2*Math.PI/180)), dy = 75/111195;
    const lon = (w+e)/2, lat = (s+n)/2;
    current.fitBounds([[Math.min(w,lon-dx),Math.min(s,lat-dy)],[Math.max(e,lon+dx),Math.max(n,lat+dy)]], { padding: 50, maxZoom: 18, duration: 250 });
  }, [ready, route]);

  useEffect(() => {
    const current = map.current;
    if (!ready || !current) return;
    (current.getSource('position') as GeoJSONSource).setData(position ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: position } } : emptyFeatures());
  }, [ready, position]);

  useEffect(() => {
    const current = map.current;
    if (!ready || !current) return;
    const markers: Marker[] = [];
    for (const [point,letter] of [[start,'A'],[destination,'B']] as const) {
      if (!point) continue;
      const element = document.createElement('span');
      element.className = `map-point-marker ${letter === 'A' ? 'map-point-start' : 'map-point-end'}`;
      element.textContent = letter; element.setAttribute('aria-hidden','true');
      markers.push(new Marker({ element }).setLngLat(point).addTo(current));
    }
    return () => markers.forEach(marker => marker.remove());
  }, [ready, start, destination]);

  return <div ref={host} className={`navigation-map${preview ? ' coverage-map' : ''}`} data-renderer="webgl" data-ready={ready && !failure}>
    <div ref={container} className="offline-map-canvas"/>
    {failure ? <div className="map-renderer-message" role="alert"><p>The map could not open. Try reopening it; you can still choose named places below.</p><button className="secondary-button" onClick={() => setAttempt(value=>value+1)}>Reopen map</button></div> : !ready && <p className="map-renderer-message" role="status">Opening offline map…</p>}
    <div className="navigation-map-controls">
      <button aria-label="Zoom in" disabled={!ready || failure} onClick={() => map.current?.zoomIn({duration:180})}><Plus/></button>
      <button aria-label="Zoom out" disabled={!ready || failure} onClick={() => map.current?.zoomOut({duration:180})}><Minus/></button>
      <button aria-label={preview ? 'Reset map view' : 'Show whole area'} disabled={!ready || failure} onClick={() => { if (map.current) fitArea(map.current); }}><RotateCcw size={19}/></button>
      {position && <button aria-label="Centre on my location" disabled={!ready || failure} onClick={() => map.current?.easeTo({center:position,zoom:Math.max(map.current.getZoom(),16),duration:200})}><LocateFixed size={19}/></button>}
    </div>
    {!preview && <a className="nav-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>}
  </div>;
}
