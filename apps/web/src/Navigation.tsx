import { useEffect, useMemo, useRef, useState } from 'react';
import { App as NativeApp } from '@capacitor/app';
import { Geolocation } from '@capacitor/geolocation';
import { ArrowLeft, ArrowRight, CheckCircle2, Compass, LocateFixed, MapPin, Navigation2, Search, Square, X } from 'lucide-react';
import { contains, distance, lineLengths, projectOnLine, type InstalledPack, type MapDrawing, type MapStorage, type Point, type Region, type WalkingRoute } from '@offgrid/maps';
import { currentPosition, native } from './native';
import { NavigationMap } from './NavigationMap';

interface Fix { point: Point; accuracy: number; timestamp: number }
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : 'Location is unavailable. You can choose your start on the map.'; }
function metres(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value / 5) * 5} m`; }
function turns(route: WalkingRoute) {
  const lengths = lineLengths(route.points);
  const result: Array<{ along: number; text: string }> = [{ along: 0, text: 'Follow the highlighted walking path' }];
  for (let i = 1; i < route.points.length - 1; i++) {
    const a = route.points[i - 1]!, b = route.points[i]!, c = route.points[i + 1]!;
    const cos = Math.cos(b[1] * Math.PI / 180);
    const first = Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]);
    const second = Math.atan2((c[0] - b[0]) * cos, c[1] - b[1]);
    let turn = (second - first) * 180 / Math.PI; turn = (turn + 540) % 360 - 180;
    if (Math.abs(turn) >= 45 && lengths[i]! - result[result.length - 1]!.along > 25 && route.metres - lengths[i]! > 15) result.push({ along: lengths[i]!, text: Math.abs(turn) > 150 ? 'Turn back along the path' : turn > 0 ? 'Turn right' : 'Turn left' });
  }
  result.push({ along: route.metres, text: 'Reach your selected destination' });
  return result;
}

export function Navigation({ store, pack, region, drawing, onClose }: { store: MapStorage; pack: InstalledPack; region: Region; drawing: MapDrawing; onClose(): void }) {
  const worker = useRef<Worker | null>(null), request = useRef(0);
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [start, setStart] = useState<Point>(), [destination, setDestination] = useState<Point>();
  const [startName, setStartName] = useState(''), [destinationName, setDestinationName] = useState('');
  const [choosing, setChoosing] = useState<'start' | 'destination'>('start');
  const [query, setQuery] = useState(''), [planned, setPlanned] = useState<WalkingRoute>();
  const [fix, setFix] = useState<Fix>(), [locating, setLocating] = useState(false);
  const [locationFeedback, setLocationFeedback] = useState<{ message: string; error: boolean }>();
  const heading = useRef<HTMLHeadingElement>(null), searchInput = useRef<HTMLInputElement>(null), guidancePanel = useRef<HTMLDivElement>(null);
  const focusEditor = useRef(false);
  const [tracking, setTracking] = useState(false), [now, setNow] = useState(Date.now());
  const [progress, setProgress] = useState(0), [arrived, setArrived] = useState(false);
  const arrivalSince = useRef<number | undefined>(undefined);
  const guidance = useMemo(() => planned ? turns(planned) : [], [planned]);
  const labels = useMemo(() => drawing.labels.filter(l => l.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 12), [drawing, query]);
  const fresh = fix && now - fix.timestamp < 20000 && fix.accuracy <= 50;
  const match = planned && fix ? projectOnLine(fix.point, planned.points) : undefined;
  const offRoute = !!(fresh && match && match.distance > Math.max(25, fix.accuracy * 1.5));
  const nextStep = guidance.find(step => step.along > progress + 10) ?? guidance[guidance.length - 1];
  useEffect(() => {
    if (tracking) { window.scrollTo(0, 0); guidancePanel.current?.focus({ preventScroll: true }); }
    else if (focusEditor.current && !planned) { searchInput.current?.focus(); focusEditor.current = false; }
    else if (planned) heading.current?.focus();
  }, [planned, tracking, choosing]);

  useEffect(() => {
    let active = true;
    const router = new Worker(new URL('./route.worker.ts', import.meta.url), { type: 'module' }); worker.current = router;
    router.onmessage = event => {
      if (!active || (event.data.id !== 0 && event.data.id !== request.current)) return;
      setLoading(false);
      if (event.data.type === 'ready') setReady(true);
      else if (event.data.type === 'route') { setPlanned(event.data.result); setProgress(0); setArrived(false); arrivalSince.current = undefined; }
      else setError(event.data.message);
    };
    router.onerror = () => { if (active) { setLoading(false); setError('The offline router stopped. Return to your library and open the map again.'); } };
    void (async () => {
      try {
        const tiles: Array<{ bytes: ArrayBuffer; hash: string }> = [];
        const routing = pack.manifest.assets.filter(a => a.kind === 'routing-tile');
        const savedFiles = await store.assets(pack.datasetId, routing.map(a => a.path));
        for (const [index, asset] of routing.entries()) {
          const saved = savedFiles[index];
          if (!saved) throw new Error('A routing file is missing. Check offline files in your library.');
          tiles.push({ bytes: await saved.blob.arrayBuffer(), hash: asset.sha256 });
          if (!active) return;
        }
        router.postMessage({ id: 0, type: 'load', tiles, bounds: pack.manifest.bounds }, tiles.map(t => t.bytes));
      } catch (cause) { if (active) { setError(errorText(cause)); setLoading(false); } }
    })();
    return () => { active = false; router.terminate(); worker.current = null; };
  }, [store, pack.datasetId]);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!tracking) return;
    let active = true, nativeWatch: string | undefined, webWatch: number | undefined;
    const receive = (value: { coords: { longitude: number; latitude: number; accuracy: number }; timestamp: number }) => {
      if (!active || !Number.isFinite(value.coords.accuracy) || value.coords.accuracy < 0 || value.timestamp > Date.now() + 5000 || Date.now() - value.timestamp > 20000) return;
      setFix({ point: [value.coords.longitude, value.coords.latitude], accuracy: value.coords.accuracy, timestamp: value.timestamp });
    };
    const failed = () => { if (active) { setTracking(false); setNotice('Location updates stopped. Check location permission and try again, or follow the route manually.'); } };
    if (native) {
      void Geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000, minimumUpdateInterval: 2000 }, (position, error) => { if (error) failed(); else if (position) receive(position); }).then(id => { nativeWatch = id; if (!active) void Geolocation.clearWatch({ id }); }).catch(failed);
    } else if (navigator.geolocation) webWatch = navigator.geolocation.watchPosition(receive, failed, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    else failed();
    const hidden = () => { if (document.hidden) { setTracking(false); setNotice('Guidance paused while the app was in the background. Resume when you are ready.'); } };
    document.addEventListener('visibilitychange', hidden);
    return () => { active = false; document.removeEventListener('visibilitychange', hidden); if (nativeWatch) void Geolocation.clearWatch({ id: nativeWatch }); if (webWatch !== undefined) navigator.geolocation.clearWatch(webWatch); };
  }, [tracking]);
  useEffect(() => {
    if (!native) return;
    const listener = NativeApp.addListener('backButton', () => { if (tracking) setTracking(false); else onClose(); });
    const state = NativeApp.addListener('appStateChange', ({ isActive }) => { if (!isActive) setTracking(false); });
    return () => { void listener.then(h => h.remove()); void state.then(h => h.remove()); };
  }, [onClose, tracking]);

  useEffect(() => {
    if (!tracking || !planned || !fix || !fresh || offRoute) { arrivalSince.current = undefined; return; }
    // A nearby later crossing must not jump the user over a loop. Match only
    // the next 150m of the route and retain progress within GPS noise.
    const lengths = lineLengths(planned.points);
    const indices = lengths.map((length, index) => ({ length, index })).filter(p => p.length >= Math.max(0, progress - 30) && p.length <= progress + 150);
    const first = Math.max(0, (indices[0]?.index ?? 1) - 1), last = Math.min(planned.points.length, (indices[indices.length - 1]?.index ?? first) + 2);
    if (last - first >= 2) {
      const projected = projectOnLine(fix.point, planned.points.slice(first, last));
      if (projected.distance <= Math.max(25, fix.accuracy)) setProgress(old => Math.max(old, lengths[first]! + projected.along));
    }
    if (fix.accuracy <= 20 && distance(fix.point, planned.destination) < 15 && planned.metres - progress < 30) {
      arrivalSince.current ??= fix.timestamp;
      if (fix.timestamp - arrivalSince.current >= 5000) { setArrived(true); setTracking(false); }
    } else arrivalSince.current = undefined;
  }, [fix, tracking, planned, fresh, offRoute]);

  const pick = (point: Point, name = 'Selected map point') => {
    if (!contains(region.bounds, point[1], point[0])) { setError('Choose a point inside this saved area.'); return; }
    request.current++; setLoading(false); setError(''); setNotice(''); setLocationFeedback(undefined); setPlanned(undefined); setTracking(false); setProgress(0); setArrived(false);
    if (choosing === 'start') { setStart(point); setStartName(name); setChoosing('destination'); }
    else { setDestination(point); setDestinationName(name); }
    setQuery('');
  };
  const locate = async () => {
    request.current++; setLoading(false); setLocating(true); setError(''); setNotice(''); setLocationFeedback(undefined);
    try {
      const result = await currentPosition();
      const point: Point = [result.coords.longitude, result.coords.latitude];
      if (!contains(region.bounds, point[1], point[0])) throw new Error('Your location is outside this saved area. Select a start manually or open another map.');
      if (!Number.isFinite(result.coords.accuracy) || result.coords.accuracy > 50 || result.coords.accuracy < 0 || Date.now() - result.timestamp > 20000 || result.timestamp > Date.now() + 5000) throw new Error('Location is too approximate for a route start. Wait for a clearer signal or choose your start manually.');
      setFix({ point, accuracy: result.coords.accuracy, timestamp: result.timestamp });
      setStart(point); setStartName('My current location'); setChoosing('destination'); setPlanned(undefined); setTracking(false);
      setLocationFeedback({ message: `Location accuracy: approximately ${Math.round(result.coords.accuracy)} m.`, error: false });
    } catch (cause) { setLocationFeedback({ message: errorText(cause), error: true }); }
    finally { setLocating(false); }
  };
  const calculate = (from = start) => {
    if (!ready || !from || !destination) return;
    setLoading(true); setError(''); setNotice(''); setTracking(false); setPlanned(undefined);
    worker.current?.postMessage({ id: ++request.current, type: 'plan', start: from, destination });
  };
  const edit = (target: 'start' | 'destination') => {
    request.current++; focusEditor.current = true; setLoading(false); setTracking(false); setPlanned(undefined); setChoosing(target); setQuery(''); setError('');
    // Choosing the already active endpoint still needs an explicit focus handoff.
    requestAnimationFrame(() => searchInput.current?.focus());
  };
  return <div className={`navigation-shell ${tracking ? 'is-guiding' : ''}`}>
    <header className="navigation-header"><button className="icon-button" aria-label="Back to map library" onClick={onClose}><ArrowLeft/></button><div><strong>{region.subtitle}</strong><span>Offline walking navigation</span></div><span className="nav-offline-tag"><Compass size={16}/>On device</span></header>
    <main className="navigation-layout">
      <NavigationMap drawing={drawing} start={planned?.start ?? start} destination={planned?.destination ?? destination} position={fix?.point} route={planned?.points} onPick={point => { if (tracking) setNotice('Pause guidance or choose Edit route to change your destination.'); else pick(point); }}/>
      <section className="navigation-sheet" aria-label="Walking route planner">
        {!tracking && <div className="navigation-sheet-heading"><h1 ref={heading} tabIndex={-1}>{arrived ? 'You have reached your point.' : planned ? 'Your walking route.' : 'Where are you heading?'}</h1><span>{region.areaKm2} km² saved area</span></div>}
        {!tracking && <div className="route-point-fields"><button className={choosing === 'start' ? 'point-field active' : 'point-field'} aria-pressed={choosing === 'start'} onClick={() => edit('start')}><span className="point-letter">A</span><span><small>Start</small><strong>{startName || 'Choose a place or tap the map'}</strong></span></button><button className={choosing === 'destination' ? 'point-field active' : 'point-field'} aria-pressed={choosing === 'destination'} onClick={() => edit('destination')}><span className="point-letter destination">B</span><span><small>Destination</small><strong>{destinationName || 'Choose a place or tap the map'}</strong></span></button></div>}
        {!planned && <>
          <button className="location-button" disabled={locating} aria-describedby={locationFeedback ? 'navigation-location-feedback' : undefined} onClick={() => void locate()}><LocateFixed size={18}/>{locating ? 'Finding your location…' : 'Use my location as start'}</button>
          {locationFeedback && <p id="navigation-location-feedback" className="location-feedback" role={locationFeedback.error ? 'alert' : 'status'}>{locationFeedback.message}</p>}
          <div className="library-search"><Search size={18}/><label className="sr-only" htmlFor="place-search">Find a place within this saved area</label><input ref={searchInput} id="place-search" placeholder={`Find ${choosing === 'start' ? 'a start' : 'a destination'} in this area`} value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" aria-label="Clear place search" onClick={() => setQuery('')}><X size={16}/></button>}</div>
          <div className="place-results" aria-label={`Places to choose as ${choosing}`}>{labels.map((label, i) => <button key={i} onClick={() => pick(label.point, label.text)}><MapPin size={16}/><span>{label.text}</span><ArrowRight size={15}/></button>)}{!labels.length && <p>No matching places in this area. Tap a mapped path or entrance instead.</p>}</div>
          <button className="primary-button" disabled={!ready || loading || !start || !destination} onClick={() => calculate()}><Navigation2 size={18}/>{loading ? ready ? 'Finding an offline route…' : 'Opening saved walking paths…' : 'Find walking route'}</button>
        </>}
        {planned && <>
          {!tracking && <div className="route-summary"><strong>{Math.max(1, Math.ceil((planned.seconds * Math.max(0, 1 - progress / planned.metres)) / 60))} min<span>approx. walking time</span></strong><strong>{metres(Math.max(0, planned.metres - progress))}<span>mapped walking path</span></strong></div>}
          {!tracking && (planned.startOffset > 5 || planned.destinationOffset > 5) && <p className="route-note">Pins connect to nearby mapped paths: {Math.round(planned.startOffset)} m at the start, {Math.round(planned.destinationOffset)} m at the destination. Check the entrance yourself.</p>}
          {tracking && <div ref={guidancePanel} tabIndex={-1} className={`guidance ${offRoute || !fresh ? 'guidance-warning' : ''}`} role="region" aria-label="Current walking guidance"><Navigation2 size={22}/><div><strong role="status">{!fresh ? 'Waiting for an accurate location' : offRoute ? 'You appear to be off the route' : nextStep?.text}</strong><span>{!fresh ? 'The route remains available. Location must be recent and within 50 m accuracy.' : offRoute ? 'Check your surroundings, then recalculate from your location.' : `${metres(Math.max(0, (nextStep?.along ?? planned.metres) - progress))} along the highlighted path`}</span><small>{metres(Math.max(0, planned.metres - progress))} remaining</small></div></div>}
          {arrived && <p className="arrival-message" role="status"><CheckCircle2/>Check your surroundings and confirm the entrance.</p>}
          <div className="route-action-row"><button className="primary-button" onClick={() => { setTracking(v => !v); setNotice(''); }} disabled={arrived}>{tracking ? <Square size={17}/> : <LocateFixed size={18}/>} {tracking ? 'Pause guidance' : 'Start location guidance'}</button><button className="secondary-button" onClick={() => edit('destination')}>Edit route</button></div>
          {offRoute && fresh && <button className="secondary-button" onClick={() => { setStart(fix.point); setStartName('My current location'); calculate(fix.point); }}>Recalculate from my location</button>}
          <details className="route-directions"><summary>Route directions · {guidance.length} steps</summary><ol>{guidance.map((step, i) => <li key={i}><span>{metres(step.along)}</span>{step.text}</li>)}</ol></details>
        </>}
        {error && <div className="message error-message" role="alert"><p>{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={18}/></button></div>}
        {notice && <p className="route-note" role="status">{notice}</p>}
        <p className="navigation-footnote">Walking routes follow OpenStreetMap paths within this area. Check access and crossings on the ground. Location guidance runs while this screen is open.</p>
      </section>
    </main>
  </div>;
}
