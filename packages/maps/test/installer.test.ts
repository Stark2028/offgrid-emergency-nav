import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MapInstaller, MapStore, parseManifest, sha256, type PackManifest, type Region } from "../src/index.js";

const stores: MapStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });
function store() { const value = new MapStore(`maps-test-${crypto.randomUUID()}`); stores.push(value); return value; }
async function fixture(generation = "a".repeat(64), padding = 0) {
  const drawing = { version: 1, bounds: [77.19, 28.59, 77.21, 28.61], roads: [{ kind: "residential", points: [[77.2, 28.6], [77.201, 28.601]] }], labels: [], padding: "x".repeat(padding) };
  const map = new TextEncoder().encode(JSON.stringify(drawing)).buffer;
  const tileBytes = readFileSync(new URL("../../core/test/fixtures/tiles/single-cell.ttnfsw.bin", import.meta.url));
  const tile = tileBytes.buffer.slice(tileBytes.byteOffset, tileBytes.byteOffset + tileBytes.byteLength) as ArrayBuffer;
  const files: Record<string, ArrayBuffer> = { "map.json": map, "tiles/ttnfsw.bin": tile };
  const manifest: PackManifest = {
    schemaVersion: 1, regionId: "test-area", datasetId: generation, profile: "walking-v1", tileVersion: 2, bounds: drawing.bounds as [number, number, number, number],
    source: { name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", timestamp: "2026-10-01T00:00:00Z", sha256: "f".repeat(64), license: "ODbL-1.0" },
    totalBytes: map.byteLength + tile.byteLength,
    assets: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, bytes: bytes.byteLength, sha256: await sha256(bytes), kind: path === "map.json" ? "basemap" as const : "routing-tile" as const }))),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)).buffer;
  const region: Region = { id: "test-area", name: "Test area", subtitle: "Fixture", coverageLabel: "Test coverage", bounds: manifest.bounds, areaKm2: 1, totalBytes: manifest.totalBytes, datasetId: generation, profile: "walking-v1", updatedAt: manifest.source.timestamp, manifestUrl: `/packs/test-area/${generation}/manifest.json`, manifestSha256: await sha256(manifestBytes), preview: drawing as unknown as Region["preview"] };
  const requests: Array<{ path: string; range: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const range = new Headers(init?.headers).get("Range");
    requests.push({ path: url.pathname, range });
    if (url.pathname.endsWith("manifest.json")) return new Response(manifestBytes);
    const key = url.pathname.split(`${generation}/`)[1]!;
    const bytes = files[key];
    if (!bytes) return new Response(null, { status: 404 });
    if (range) {
      const offset = Number(range.match(/bytes=(\d+)-/)?.[1]);
      if (offset >= bytes.byteLength) return new Response(null, { status: 416 });
      return new Response(bytes.slice(offset), { status: 206, headers: { "Content-Range": `bytes ${offset}-${bytes.byteLength - 1}/${bytes.byteLength}` } });
    }
    return new Response(bytes);
  };
  return { region, manifest, manifestBytes, files, requests, fetcher };
}

describe("verified offline installation", () => {
  it("publishes a generation only after validating all files, then verifies without a network", async () => {
    const pack = await fixture(); const db = store();
    const installer = new MapInstaller(db, { fetch: pack.fetcher });
    await installer.install(pack.region);
    expect((await db.installed(pack.region.id))?.datasetId).toBe(pack.region.datasetId);
    const offline = new MapInstaller(db, { fetch: async () => { throw new Error("offline"); } });
    await expect(offline.verify(pack.region.id)).resolves.toMatchObject({ datasetId: pack.region.datasetId });
    expect((await db.snapshot()).downloads[0]?.phase).toBe("ready");
  });
  it("rejects corrupted content and never reports a first install as ready", async () => {
    const pack = await fixture(); const db = store();
    const fetcher: typeof fetch = async (url, init) => String(url).endsWith("map.json") ? new Response("damaged") : pack.fetcher(url, init);
    await expect(new MapInstaller(db, { fetch: fetcher }).install(pack.region)).rejects.toThrow();
    expect(await db.installed(pack.region.id)).toBeUndefined();
    expect((await db.snapshot()).downloads[0]?.phase).toBe("error");
    await new MapInstaller(db, { fetch: pack.fetcher }).install(pack.region);
    expect(await db.installed(pack.region.id)).toBeDefined();
  });
  it("resumes a persisted prefix with Range after connection loss", async () => {
    const pack = await fixture("a".repeat(64), 180000); const db = store();
    const prefix = 60000;
    let sent = false;
    const broken: typeof fetch = async (url, init) => {
      if (!String(url).endsWith("map.json")) return pack.fetcher(url, init);
      return new Response(new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(pack.files["map.json"]!.slice(0, prefix))); } else controller.error(new Error("connection lost")); } }));
    };
    await expect(new MapInstaller(db, { fetch: broken }).install(pack.region)).rejects.toThrow();
    expect((await db.partial(pack.region.datasetId, "map.json"))?.bytes).toBe(prefix);
    await new MapInstaller(db, { fetch: pack.fetcher }).install(pack.region);
    expect(pack.requests.some((request) => request.range === `bytes=${prefix}-`)).toBe(true);
    expect(await db.partial(pack.region.datasetId, "map.json")).toBeUndefined();
  });
  it("restarts a file when a server ignores Range rather than appending it twice", async () => {
    const pack = await fixture(); const db = store();
    await db.checkpoint(pack.region.datasetId, "map.json", new Blob([pack.files["map.json"]!.slice(0, 20)]));
    const fetcher: typeof fetch = (url, init) => pack.fetcher(url, { ...init, headers: {} });
    await new MapInstaller(db, { fetch: fetcher }).install(pack.region);
    expect((await db.asset(pack.region.datasetId, "map.json"))?.bytes).toBe(pack.files["map.json"]!.byteLength);
  });
  it("rejects a mismatched resumed range", async () => {
    const pack = await fixture(); const db = store();
    await db.checkpoint(pack.region.datasetId, "map.json", new Blob([pack.files["map.json"]!.slice(0, 20)]));
    const fetcher: typeof fetch = (url, init) => String(url).endsWith("map.json") ? Promise.resolve(new Response("bad", { status: 206, headers: { "Content-Range": "bytes 0-2/3" } })) : pack.fetcher(url, init);
    await expect(new MapInstaller(db, { fetch: fetcher }).install(pack.region)).rejects.toThrow(/invalid resumed/);
    expect(await db.installed(pack.region.id)).toBeUndefined();
  });
  it("preserves the previous installed generation when an update fails", async () => {
    const first = await fixture(); const next = await fixture("b".repeat(64)); const db = store();
    await new MapInstaller(db, { fetch: first.fetcher }).install(first.region);
    const broken: typeof fetch = async (url, init) => String(url).endsWith("map.json") ? new Response(null, { status: 503 }) : next.fetcher(url, init);
    await expect(new MapInstaller(db, { fetch: broken }).install(next.region)).rejects.toThrow();
    expect((await db.installed(first.region.id))?.datasetId).toBe(first.region.datasetId);
    await expect(new MapInstaller(db).verify(first.region.id)).resolves.toBeDefined();
    await new MapInstaller(db, { fetch: next.fetcher }).install(next.region);
    expect((await db.installed(first.region.id))?.datasetId).toBe(next.region.datasetId);
    expect(await db.asset(first.region.datasetId, "map.json")).toBeUndefined();
  });
  it("rejects a manifest that does not match its trusted catalogue hash", async () => {
    const pack = await fixture(); const db = store();
    const region = { ...pack.region, manifestSha256: "0".repeat(64) };
    await expect(new MapInstaller(db, { fetch: pack.fetcher }).install(region)).rejects.toThrow(/catalogue/);
    expect(await db.installed(pack.region.id)).toBeUndefined();
  });
  it("does not activate a pack if the storage estimate cannot accommodate it", async () => {
    const pack = await fixture(); const db = store();
    await expect(new MapInstaller(db, { fetch: pack.fetcher, availableBytes: async () => 0 }).install(pack.region)).rejects.toThrow(/enough storage/);
    expect(await db.installed(pack.region.id)).toBeUndefined();
  });
  it("withdraws readiness if a saved file becomes damaged and supports repair", async () => {
    const pack = await fixture(); const db = store(); const installer = new MapInstaller(db, { fetch: pack.fetcher });
    await installer.install(pack.region);
    await db.stage(pack.region.datasetId, "map.json", new Blob(["bad"]), pack.manifest.assets[0]!.sha256);
    await expect(installer.verify(pack.region.id)).rejects.toThrow();
    expect(await db.installed(pack.region.id)).toBeUndefined();
    await installer.install(pack.region);
    await expect(installer.verify(pack.region.id)).resolves.toBeDefined();
  });
  it("removes active and staged files and refuses another live writer", async () => {
    const pack = await fixture(); const db = store(); const installer = new MapInstaller(db, { fetch: pack.fetcher });
    expect(await db.acquire(pack.region.id, "other-tab")).toBe(true);
    await expect(installer.install(pack.region)).rejects.toThrow(/another tab/);
    await db.release(pack.region.id, "other-tab");
    await installer.install(pack.region);
    await installer.remove(pack.region.id);
    expect(await db.installed(pack.region.id)).toBeUndefined();
    expect(await db.asset(pack.region.datasetId, "map.json")).toBeUndefined();
    expect((await db.snapshot()).downloads).toHaveLength(0);
  });
  it("can validate a complete persisted prefix after a 416 response", async () => {
    const pack = await fixture(); const db = store();
    await db.checkpoint(pack.region.datasetId, "map.json", new Blob([pack.files["map.json"]!]));
    await new MapInstaller(db, { fetch: pack.fetcher }).install(pack.region);
    expect(await db.installed(pack.region.id)).toBeDefined();
  });
  it("discards a corrupt complete prefix and retries a fresh copy once", async () => {
    const pack = await fixture(); const db = store();
    await db.checkpoint(pack.region.datasetId, "map.json", new Blob([new Uint8Array(pack.files["map.json"]!.byteLength)]));
    await new MapInstaller(db, { fetch: pack.fetcher }).install(pack.region);
    expect(await db.installed(pack.region.id)).toBeDefined();
    expect(pack.requests.filter((r) => r.path.endsWith("map.json"))).toHaveLength(2);
  });
  it("removes abandoned generations as well as the active one", async () => {
    const first = await fixture(); const abandoned = await fixture("b".repeat(64)); const latest = await fixture("c".repeat(64)); const db = store();
    await new MapInstaller(db, { fetch: first.fetcher }).install(first.region);
    await db.register(abandoned.manifest);
    await db.checkpoint(abandoned.region.datasetId, "map.json", new Blob(["prefix"]));
    const broken: typeof fetch = async (url, init) => String(url).endsWith("map.json") ? new Response(null, { status: 503 }) : latest.fetcher(url, init);
    await expect(new MapInstaller(db, { fetch: broken }).install(latest.region)).rejects.toThrow();
    await new MapInstaller(db).remove(first.region.id);
    expect(await db.partial(abandoned.region.datasetId, "map.json")).toBeUndefined();
    expect(await db.asset(first.region.datasetId, "map.json")).toBeUndefined();
  });
  it("an old verification failure cannot withdraw a newly installed generation", async () => {
    const first = await fixture(); const next = await fixture("b".repeat(64)); const db = store();
    await new MapInstaller(db, { fetch: first.fetcher }).install(first.region);
    await new MapInstaller(db, { fetch: next.fetcher }).install(next.region);
    await db.forgetInstallation(first.region.id, first.region.datasetId);
    expect((await db.installed(first.region.id))?.datasetId).toBe(next.region.datasetId);
  });
  it("the active pointer cannot be committed before all verified records exist", async () => {
    const pack = await fixture(); const db = store();
    await expect(db.commit(pack.manifest)).rejects.toThrow(/missing/);
    expect(await db.installed(pack.region.id)).toBeUndefined();
  });
  it('a stale file check cannot withdraw a newer activation of the same repaired generation', async () => {
    const pack=await fixture(),db=store();
    await new MapInstaller(db,{fetch:pack.fetcher}).install(pack.region);
    const active=(await db.installed(pack.region.id))!;
    await db.forgetInstallation(pack.region.id,pack.region.datasetId,active.installedAt-1);
    expect(await db.installed(pack.region.id)).toBeDefined();
    await db.forgetInstallation(pack.region.id,pack.region.datasetId,active.installedAt);
    expect(await db.installed(pack.region.id)).toBeUndefined();
  });
});

describe('stalled connections', () => {
  it('ends a stalled header request and leaves the installed generation intact', async () => {
    const first=await fixture(), next=await fixture('b'.repeat(64)); const db=store();
    await new MapInstaller(db,{fetch:first.fetcher}).install(first.region);
    const stalled: typeof fetch=async (_url,init)=>new Promise((_resolve,reject)=> {
      init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    });
    await expect(new MapInstaller(db,{fetch:stalled,networkTimeoutMs:20}).install(next.region)).rejects.toThrow('stopped responding');
    expect((await db.installed(first.region.id))?.datasetId).toBe(first.region.datasetId);
    expect((await db.snapshot()).downloads[0]?.phase).toBe('error');
  });
  it('saves a partial body when the next chunk never arrives', async () => {
    const pack=await fixture('c'.repeat(64),200000),db=store();
    const stalled: typeof fetch=async (url,init)=> {
      if (!String(url).endsWith('map.json')) return pack.fetcher(url,init);
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(new Uint8Array(pack.files['map.json']!.slice(0,1024)));
        init?.signal?.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});
      }}));
    };
    await expect(new MapInstaller(db,{fetch:stalled,networkTimeoutMs:20}).install(pack.region)).rejects.toThrow('stopped responding');
    expect((await db.partial(pack.region.datasetId,'map.json'))?.bytes).toBe(1024);
    expect(await db.installed(pack.region.id)).toBeUndefined();
  });
});

describe("manifest contract", () => {
  it.each(["../outside.bin", "/absolute.bin", "tiles/%2e%2e/bin", "https://other.test/map.json"]) ("rejects unsafe path %s", async (path) => {
    const pack = await fixture();
    const manifest = structuredClone(pack.manifest); manifest.assets[0]!.path = path;
    expect(() => parseManifest(manifest, pack.region)).toThrow(/manifest/);
  });
  it("rejects a different generation, duplicate paths and incorrect totals", async () => {
    const pack = await fixture();
    expect(() => parseManifest({ ...pack.manifest, datasetId: "b".repeat(64) }, pack.region)).toThrow();
    expect(() => parseManifest({ ...pack.manifest, assets: [pack.manifest.assets[0], pack.manifest.assets[0]] }, pack.region)).toThrow();
    expect(() => parseManifest({ ...pack.manifest, totalBytes: 1 }, pack.region)).toThrow();
    expect(() => parseManifest({ ...pack.manifest, profile: "motor-v1" }, pack.region)).toThrow();
  });
});
