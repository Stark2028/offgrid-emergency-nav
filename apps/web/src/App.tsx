import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowRight, Check, CheckCheck, CheckCircle2, ChevronRight, Compass, Download, HardDrive, Info, Layers2, LocateFixed, Map, MapPin, Mountain, Pause, RefreshCw, Search, ShieldCheck, Smartphone, Trash2, Wifi, WifiOff, X } from "lucide-react";
import { contains, MapInstaller, parseDrawing, type DownloadRecord, type InstalledPack, type MapDrawing, type Region } from "@offgrid/maps";
import { createMapStore, native, availableBytes, currentPosition } from './native';
const Navigation = lazy(() => import('./Navigation').then(m => ({ default: m.Navigation })));
import catalogue from "./generated/catalog.json";
import { AreaMap, VectorMap } from "./AreaMap";

const regions = catalogue.regions as unknown as Region[];
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const sourceDate = (date: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(date));
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

export function App() {
  const [store] = useState(() => { try { return createMapStore(); } catch { return null; } });
  const [navigating, setNavigating] = useState(false);
  const [installed, setInstalled] = useState<InstalledPack[]>([]);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [verified, setVerified] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState(() => {
    try { const last = localStorage.getItem('offgrid-last-area'); if (regions.some(r => r.id === last)) return last!; } catch { /* Optional preference. */ }
    return regions[0]?.id ?? '';
  });
  const [view, setView] = useState<"explore" | "downloaded">("explore");
  const [search, setSearch] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [storageAvailable, setStorageAvailable] = useState(!!store);
  const [freeBytes, setFreeBytes] = useState<number | undefined>();
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");
  const [position, setPosition] = useState<[number, number] | undefined>();
  const [drawing, setDrawing] = useState<MapDrawing | undefined>();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [appUpdate, setAppUpdate] = useState<ServiceWorker | null>(null);
  const [persistent, setPersistent] = useState<boolean | undefined>();

  const refresh = useCallback(async () => {
    if (!store) return;
    const snapshot = await store.snapshot();
    setInstalled(snapshot.installed);
    setDownloads(snapshot.downloads);
    setFreeBytes(await availableBytes().catch(() => undefined));
  }, [store]);
  const installer = useMemo(() => store ? new MapInstaller(store, {
    onProgress: (record) => {
      setDownloads((old) => [...old.filter((r) => r.regionId !== record.regionId), record]);
      if (record.phase === "ready") { setVerified((old) => new Set(old).add(record.regionId)); void refresh().catch(() => undefined); }
    },
    availableBytes,
  }) : null, [store, refresh]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await refresh();
        const snapshot = await store?.snapshot();
        for (const pack of snapshot?.installed ?? []) {
          try { await installer?.verify(pack.regionId); if (active) setVerified((old) => new Set(old).add(pack.regionId)); }
          catch { if (active) setError("Some saved map files are missing or damaged. Select the area and download it again to repair it."); }
        }
        if (active) await refresh();
      } catch (cause) { if (active) { setStorageAvailable(false); setError(cause instanceof Error ? cause.message : "Local storage is unavailable. Reopen the app and try again."); } }
      finally { if (active) setInitializing(false); }
    })();
    const handleOnline = () => setOnline(navigator.onLine);
    const handleFocus = () => { void refresh().catch(() => undefined); };
    const handleInstall = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent); };
    addEventListener("online", handleOnline); addEventListener("offline", handleOnline); addEventListener("focus", handleFocus); addEventListener("beforeinstallprompt", handleInstall);
    return () => { active = false; removeEventListener("online", handleOnline); removeEventListener("offline", handleOnline); removeEventListener("focus", handleFocus); removeEventListener("beforeinstallprompt", handleInstall); };
  }, [store, installer, refresh]);

  useEffect(() => {
    if (native) { setShellReady(true); return; }
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let active = true;
    let reloadOnControl = false;
    const control = () => { if (reloadOnControl) location.reload(); };
    const activate = (event: Event) => {
      if ((event as CustomEvent).detail === "activate-offgrid-update") reloadOnControl = true;
    };
    navigator.serviceWorker.addEventListener("controllerchange", control);
    addEventListener("offgrid-update", activate);
    void navigator.serviceWorker.register("/sw.js").then(async (registration) => {
      const waiting = () => { if (active && registration.waiting) setAppUpdate(registration.waiting); };
      waiting();
      registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", waiting));
      await navigator.serviceWorker.ready;
      if (active) setShellReady(true);
    }).catch(() => { if (active) setNotice("The offline app shell could not be saved. Reopen while connected to try again."); });
    return () => { active = false; navigator.serviceWorker.removeEventListener("controllerchange", control); removeEventListener("offgrid-update", activate); };
  }, []);

  const selected = regions.find((region) => region.id === selectedId);
  const saved = installed.find((pack) => pack.regionId === selectedId);
  const record = downloads.find((download) => download.regionId === selectedId);
  const isBusy = busy.has(selectedId);
  const isReady = !!saved && verified.has(selectedId);
  const updateAvailable = !!saved && saved.datasetId !== selected?.datasetId;
  const shownRegion = selected && saved && isReady ? {
    ...selected, bounds: saved.manifest.bounds,
    areaKm2: Math.round((saved.manifest.bounds[2] - saved.manifest.bounds[0]) * (saved.manifest.bounds[3] - saved.manifest.bounds[1]) * 111.195 ** 2 * Math.cos((saved.manifest.bounds[1] + saved.manifest.bounds[3]) / 2 * Math.PI / 180) * 100) / 100,
  } : selected;
  const complete = installed.filter((pack) => verified.has(pack.regionId));
  const savedBytes = complete.reduce((sum, pack) => sum + pack.manifest.totalBytes, 0);
  const filtered = regions.filter((region) => `${region.name} ${region.subtitle} ${region.coverageLabel}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).filter((region) => view === "explore" || installed.some((pack) => pack.regionId === region.id) || downloads.some((r) => r.regionId === region.id && r.phase !== "ready"));

  useEffect(() => {
    setDrawing(undefined); setConfirmRemove(false);
    let active = true;
    if (saved && isReady) void store?.asset(saved.datasetId, "map.json").then(async (asset) => { if (!asset) return; const map = parseDrawing(JSON.parse(await asset.blob.text())); if (active) setDrawing(map); }).catch(() => { if (active) setError("The offline map could not be opened. Check the saved files or download the area again."); });
    return () => { active = false; };
  }, [selectedId, saved?.datasetId, isReady, store]);

  const select = (id: string) => { setSelectedId(id); try { localStorage.setItem('offgrid-last-area', id); } catch { /* Optional preference. */ } setError(""); setNotice(""); };
  const download = async () => {
    if (!selected || !installer) return;
    setError(""); setNotice("");
    setBusy((old) => new Set(old).add(selected.id));
    try {
      if (!native && navigator.storage?.persist) setPersistent(await navigator.storage.persist().catch(() => false));
      await installer.install(selected);
      setNotice(`${selected.subtitle} is saved on this device. Its map and road files passed verification.`);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "The download stopped. Check your connection and resume.");
    } finally {
      setBusy((old) => { const next = new Set(old); next.delete(selected.id); return next; });
      await refresh().catch(() => undefined);
    }
  };
  const locate = () => {
    setError(""); setNotice(""); setLocationMessage(""); setPosition(undefined);
    if (!navigator.geolocation) { setLocationMessage("This browser cannot get your location. Search for an area instead."); return; }
    setLocationBusy(true);
    void currentPosition().then((result) => {
      setLocationBusy(false);
      const { latitude, longitude, accuracy } = result.coords;
      const match = regions.find((region) => contains(region.bounds, latitude, longitude));
      if (!match) { setLocationMessage("Your location is outside the available starter areas. Search for an area or check its boundary manually."); return; }
      select(match.id); setView("explore"); setSearch(""); setPosition([longitude, latitude]);
      setLocationMessage(`Showing the area around your location. Location accuracy: approximately ${Math.round(accuracy)} m. Your coordinates stay on this device.`);
    }, (cause) => {
      setLocationBusy(false);
      setLocationMessage(cause.code === 1 ? "Location permission was not granted. You can still choose an area manually." : "Your location could not be found. Search for an area instead.");
    });
  };
  const verify = async () => {
    if (!installer || !selected) return;
    setChecking(true); setError(""); setNotice("");
    try { await installer.verify(selected.id); setNotice("Offline file check passed. All saved map and road files are intact; no network connection was used."); }
    catch (cause) { setVerified((old) => { const next = new Set(old); next.delete(selected.id); return next; }); setError(cause instanceof Error ? cause.message : "The offline file check failed. Download the area again."); }
    finally { setChecking(false); await refresh().catch(() => undefined); }
  };
  const remove = async () => {
    if (!installer || !selected) return;
    try { await installer.remove(selected.id); setVerified((old) => { const next = new Set(old); next.delete(selected.id); return next; }); setConfirmRemove(false); setNotice(native ? "Area removed from offline storage. You can save it again from this app build." : "Area removed from this device. You will need a connection to download it again."); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The map could not be removed. Try again."); }
  };
  const installApp = async () => {
    if (installEvent) { await installEvent.prompt(); await installEvent.userChoice; setInstallEvent(null); }
    else setInstallHelp((old) => !old);
  };
  const progress = record ? Math.min(100, Math.round(record.downloadedBytes / record.totalBytes * 100)) : 0;
  const interrupted = !isBusy && record && record.phase !== "ready";
  const buttonLabel = initializing ? "Checking saved maps…" : interrupted ? native ? "Resume saving" : "Resume download" : saved && saved.datasetId !== selected?.datasetId ? native ? "Save map update" : "Download update" : native ? "Save this area" : "Download this area";

  if (navigating && store && saved && shownRegion && drawing && isReady) return <Suspense fallback={<main className="recovery-screen" role="status">Opening your offline map…</main>}><Navigation store={store} pack={saved} region={shownRegion} drawing={drawing} onClose={() => setNavigating(false)}/></Suspense>;

  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to map setup</a>
    <header className="app-header">
      <a className="wordmark" href="/" aria-label="OFFGRID home"><span className="brand-mark"><Mountain size={21} strokeWidth={1.8}/></span>OFFGRID<span className="wordmark-dot">.</span></a>
      <div className="header-purpose">A map you can keep.</div>
      <div className="header-actions"><span className={`connection ${online ? "" : "connection-offline"}`}>{online ? <Wifi size={15}/> : <WifiOff size={15}/>}<span>{online ? "Connected" : "Offline"}</span></span>{appUpdate ? <button className="install-button" disabled={busy.size > 0} title={busy.size ? "Pause downloads before updating the app" : "Load the new app version; saved maps are retained"} onClick={() => { dispatchEvent(new CustomEvent("offgrid-update", { detail: "activate-offgrid-update" })); appUpdate.postMessage({ type: "ACTIVATE_UPDATE" }); }}><RefreshCw size={16}/>Update app</button> : !native && <button className="install-button" onClick={() => void installApp()}><Smartphone size={16}/><span>Install app</span><ArrowDownToLine size={14}/></button>}</div>
    </header>
    {installHelp && <div className="install-help" role="status"><Smartphone size={20}/><p>Use your browser menu to choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>. Download an area before going offline.</p><button className="icon-button" aria-label="Close installation instructions" onClick={() => setInstallHelp(false)}><X size={18}/></button></div>}
    <main id="main" className="workspace">
      <aside className="library-panel" aria-label="Map area library">
        <div className="library-heading"><div className="heading-icon"><Map size={24} strokeWidth={1.5}/></div><h1>Find your<br/> offline area.</h1><p>Choose a place. Save its map.<br/> Take it beyond the signal.</p></div>
        <nav className="library-tabs" aria-label="Map library"><button className={view === "explore" ? "active" : ""} aria-pressed={view === "explore"} onClick={() => setView("explore")}>Explore areas</button><button className={view === "downloaded" ? "active" : ""} aria-pressed={view === "downloaded"} onClick={() => setView("downloaded")}>Downloaded<span>{complete.length}</span></button></nav>
        <div className="library-search"><Search size={17}/><label className="sr-only" htmlFor="area-search">Search city or area</label><input id="area-search" placeholder="Search city or area" value={search} onChange={(event) => setSearch(event.target.value)}/>{search && <button className="search-clear" aria-label="Clear search" onClick={() => setSearch("")}><X size={15}/></button>}</div>
        <button className="location-button" onClick={locate} disabled={locationBusy} aria-describedby={locationMessage ? "location-feedback" : undefined}><LocateFixed size={16} className={locationBusy ? "spin" : ""}/>{locationBusy ? "Finding your location…" : "Use my location"}<ArrowRight size={15}/></button>
        {locationMessage && <p id="location-feedback" className="location-feedback" role="status">{locationMessage}</p>}
        <div className="list-heading"><span>{view === "explore" ? native ? "Included in this build" : "Available to download" : "On this device"}</span><span>{filtered.length} {filtered.length === 1 ? "area" : "areas"}</span></div>
        <div className="area-list">{filtered.map((region) => {
          const ready = complete.some((pack) => pack.regionId === region.id);
          const state = downloads.find((r) => r.regionId === region.id);
          return <button key={region.id} className={`area-row ${selectedId === region.id ? "selected" : ""}`} aria-pressed={selectedId === region.id} onClick={() => select(region.id)}><div className="area-thumbnail"><VectorMap drawing={region.preview} compact/></div><div className="area-row-copy"><strong>{region.name}</strong><span>{region.subtitle}</span><small>{ready ? <><Check size={12}/>Saved offline</> : <>{formatBytes(region.totalBytes)}<span className="meta-divider">·</span>{state && state.phase !== "ready" ? "Resume available" : `${region.areaKm2} km²`}</>}</small></div><ChevronRight size={17}/></button>;
        })}{filtered.length === 0 && <div className="empty-state"><MapPin size={25}/><strong>{view === "downloaded" ? "Your first map starts here." : "No matching areas yet."}</strong><p>{view === "downloaded" ? "Choose an area from Explore to keep it on this device." : "Try Prayagraj, Delhi, Hauz Khas, Noida, or a nearby area name."}</p>{view === "downloaded" && <button className="text-button" onClick={() => { setView("explore"); setSearch(""); }}>Explore available areas <ArrowRight size={15}/></button>}</div>}</div>
        <div className="starter-note"><Info size={16}/><p>Check the boundary before you save.<br/>{selected?.coverageType === 'city-area' ? 'This city-area pack includes the named towns within its download rectangle. It does not cover the whole district.' : <>These are starter areas, <strong>not full-city maps</strong>. Check the outline before downloading.</>}</p></div>
        <div className="storage-summary"><HardDrive size={17}/><div><strong>{formatBytes(savedBytes)} saved locally</strong><span>{freeBytes !== undefined ? `${formatBytes(freeBytes)} ${native ? "device" : "browser"} space available` : "Maps stay on this device"}</span></div><span className="storage-indicator" aria-hidden="true"/></div>
      </aside>
      <div className="area-workspace">
        <div className="workspace-topline"><span><Compass size={15}/>Your offline library</span><span>{complete.length ? `${complete.length} ${complete.length === 1 ? "area" : "areas"} saved` : "Prepare while connected"}</span></div>
        {selected ? <>
          <div className="area-title-row"><div><h2>{selected.subtitle}</h2><p><MapPin size={14}/>{selected.name}, India<span className="meta-divider">·</span>{selected.coverageLabel}</p></div><span className={`area-state ${isReady ? "area-state-ready" : ""}`}>{isReady ? <CheckCircle2 size={15}/> : <Layers2 size={15}/>} {isReady ? "Saved on this device" : "Coverage preview"}</span></div>
          <AreaMap key={selected.id} drawing={drawing ?? selected.preview} title={selected.subtitle} coverage={`${shownRegion?.areaKm2 ?? selected.areaKm2} km² download area`} installed={isReady && !!drawing} position={position && contains(selected.bounds, position[1], position[0]) ? position : undefined}/>
          {updateAvailable && <p className="inline-status"><Info size={16}/>Your saved version is shown above and remains available. Download the update below to replace it with the latest coverage and source date.</p>}
          {isReady && drawing && <button className="primary-button navigate-button" onClick={() => setNavigating(true)}><Compass size={20}/>Open walking navigation<ArrowRight size={18}/></button>}
          <section className="download-panel" aria-labelledby="download-heading">
            <div className="download-intro"><span className={`download-emblem ${isReady ? "ready" : ""}`}>{isReady ? <CheckCheck size={25}/> : <ArrowDownToLine size={24}/>}</span><div><h3 id="download-heading">{isReady ? "A little less dependent on signal." : "Keep this corner of the world."}</h3><p>{isReady ? "Verified map files are stored on this device." : native ? "Save the street map and walking paths included in this app build." : "Download the street map and road network together."}</p></div></div>
            <dl className="pack-facts"><div><dt>{native ? "Map size" : "Download size"}</dt><dd>{formatBytes(selected.totalBytes)}</dd></div><div><dt>Coverage</dt><dd>{selected.areaKm2} km²</dd></div><div><dt>Source updated</dt><dd>{sourceDate(selected.updatedAt)}</dd></div><div><dt>Included</dt><dd>Streets & paths</dd></div></dl>
            {(isBusy || interrupted) && <div className="download-progress" role="status"><div><span>{isBusy ? record?.phase === "verifying" ? "Checking every file…" : native ? "Saving your area…" : "Downloading your area…" : record?.phase === "error" ? "Download interrupted" : "Progress saved"}</span><strong>{progress}%</strong></div><progress max="100" value={progress} aria-label="Map download progress"/><p>{formatBytes(record?.downloadedBytes ?? 0)} of {formatBytes(selected.totalBytes)}{!isBusy && " · Resume from your saved progress"}</p></div>}
            <div className="download-actions">{isBusy ? <button className="primary-button" onClick={() => void installer?.pause(selected.id)}><Pause size={17}/>{native ? "Pause saving" : "Pause download"}</button> : isReady && saved?.datasetId === selected.datasetId ? <button className="primary-button verified-button" onClick={() => void verify()} disabled={checking}><ShieldCheck size={18} className={checking ? "pulse" : ""}/>{checking ? "Checking offline files…" : "Check offline files"}<Check size={17}/></button> : <button className="primary-button" onClick={() => void download()} disabled={!storageAvailable || (!native && !online) || checking || initializing}><Download size={18}/>{buttonLabel}<span>{formatBytes(selected.totalBytes)}</span></button>}
              {(saved || interrupted) && !isBusy && <button className="remove-button" disabled={checking || initializing} onClick={() => setConfirmRemove((old) => !old)} aria-label="Remove this area from this device"><Trash2 size={17}/></button>}
              <p className="download-assurance"><ShieldCheck size={14}/>{isReady ? "Stored locally · no account needed" : "Verified files · pause and resume anytime"}</p>
            </div>
            {confirmRemove && <div className="remove-confirmation"><p>{native ? "Remove this map? You can save this area again from this app build." : "Remove this map? You’ll need a connection to download it again."}</p><button className="danger-button" onClick={() => void remove()}>Remove map</button><button className="text-button" onClick={() => setConfirmRemove(false)}>Keep map</button></div>}
            {!native && !online && !isReady && <p className="inline-status"><WifiOff size={16}/>This area needs a connection to download. Your saved maps still work offline.</p>}
            {persistent === false && <p className="inline-status"><Info size={16}/>Your browser may clear these files when storage is low. Check saved maps before going offline.</p>}
            {error && <div className="message error-message" role="alert"><Info size={18}/><p>{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={16}/></button></div>}
            {notice && <div className="message notice-message" role="status"><Info size={18}/><p>{notice}</p><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice("")}><X size={16}/></button></div>}
          </section>
          <div className="preparation-note"><Smartphone size={18}/><p>{native ? "Published maps are included in this test build." : "Download before you disconnect."} <span>{shellReady ? "The app shell is saved for offline reopening." : "Install the app and open it once while connected."} Walking routes work within saved coverage. Hazard sharing is still in development.</span></p></div>
        </> : <div className="catalogue-empty"><Map size={35}/><h2>No published map areas yet.</h2><p>Build a verified map pack to add an area to this catalogue.</p></div>}
      </div>
    </main>
    <footer className="app-footer"><span><span className="tiny-brand"/>Built to carry on.</span><span>Your maps. Your device. No location uploads.</span><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data: OpenStreetMap · ODbL</a></footer>
  </div>;
}
