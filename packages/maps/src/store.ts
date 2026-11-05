import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { PackManifest } from "./manifest.js";

export type DownloadPhase = "downloading" | "verifying" | "paused" | "error" | "ready";
export interface DownloadRecord {
  regionId: string;
  datasetId: string;
  phase: DownloadPhase;
  downloadedBytes: number;
  totalBytes: number;
  updatedAt: number;
  message?: string;
}
export interface InstalledPack {
  regionId: string;
  datasetId: string;
  manifest: PackManifest;
  installedAt: number;
}
export interface AssetRecord { datasetId: string; path: string; blob: Blob; sha256: string; bytes: number }
export interface PartialRecord { datasetId: string; path: string; blob: Blob; bytes: number }
export interface MapStorage {
  close(): Promise<void>;
  snapshot(): Promise<{ installed: InstalledPack[]; downloads: DownloadRecord[] }>;
  installed(regionId: string): Promise<InstalledPack | undefined>;
  record(record: DownloadRecord): Promise<void>;
  register(manifest: PackManifest): Promise<void>;
  asset(datasetId: string, path: string): Promise<AssetRecord | undefined>;
  assets(datasetId: string, paths: readonly string[]): Promise<Array<AssetRecord | undefined>>;
  partial(datasetId: string, path: string): Promise<PartialRecord | undefined>;
  checkpoint(datasetId: string, path: string, blob: Blob): Promise<void>;
  clearPartial(datasetId: string, path: string): Promise<void>;
  stage(datasetId: string, path: string, blob: Blob, digest: string): Promise<void>;
  commit(manifest: PackManifest): Promise<void>;
  forgetInstallation(regionId: string, expectedDatasetId: string, expectedInstalledAt?: number): Promise<void>;
  remove(regionId: string): Promise<void>;
  prune(datasetId: string): Promise<void>;
  acquire(regionId: string, owner: string): Promise<boolean>;
  release(regionId: string, owner: string): Promise<void>;
}
interface MapDatabase extends DBSchema {
  downloads: { key: string; value: DownloadRecord };
  installed: { key: string; value: InstalledPack };
  assets: { key: [string, string]; value: AssetRecord; indexes: { "by-dataset": string } };
  partials: { key: [string, string]; value: PartialRecord; indexes: { "by-dataset": string } };
  leases: { key: string; value: { regionId: string; owner: string; expires: number } };
  generations: { key: string; value: { datasetId: string; regionId: string }; indexes: { "by-region": string } };
}

/** Verified assets are staged by generation; only commit() changes the active pointer. */
export class MapStore implements MapStorage {
  private readonly database: Promise<IDBPDatabase<MapDatabase>>;
  constructor(name = "offgrid-maps-v1") {
    this.database = new Promise((resolve, reject) => {
      let refused = false;
      openDB<MapDatabase>(name, 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("downloads", { keyPath: "regionId" });
          db.createObjectStore("installed", { keyPath: "regionId" });
          for (const name of ["assets", "partials"] as const) {
            db.createObjectStore(name, { keyPath: ["datasetId", "path"] }).createIndex("by-dataset", "datasetId");
          }
          db.createObjectStore("leases", { keyPath: "regionId" });
        }
        if (oldVersion < 2) db.createObjectStore("generations", { keyPath: "datasetId" }).createIndex("by-region", "regionId");
      },
      blocked() {
        refused = true;
        reject(new Error('Close other OFFGRID tabs, then reopen the app to upgrade local map storage.'));
      },
      blocking(_current, _blocked, event) { (event.target as IDBDatabase).close(); },
      }).then(db => { if (refused) db.close(); else resolve(db); }, reject);
    });
    void this.database.catch(() => undefined);
  }
  async close(): Promise<void> { (await this.database).close(); }
  async snapshot(): Promise<{ installed: InstalledPack[]; downloads: DownloadRecord[] }> {
    const db = await this.database;
    const [installed, downloads] = await Promise.all([db.getAll("installed"), db.getAll("downloads")]);
    return { installed, downloads };
  }
  async installed(regionId: string): Promise<InstalledPack | undefined> { return (await this.database).get("installed", regionId); }
  async record(record: DownloadRecord): Promise<void> { await (await this.database).put("downloads", record); }
  async register(manifest: PackManifest): Promise<void> { await (await this.database).put("generations", { datasetId: manifest.datasetId, regionId: manifest.regionId }); }
  async asset(datasetId: string, path: string): Promise<AssetRecord | undefined> { return (await this.database).get("assets", [datasetId, path]); }
  async assets(datasetId: string, paths: readonly string[]): Promise<Array<AssetRecord | undefined>> {
    const tx = (await this.database).transaction('assets', 'readonly');
    const records = await Promise.all(paths.map(path => tx.store.get([datasetId, path])));
    await tx.done; return records;
  }
  async partial(datasetId: string, path: string): Promise<PartialRecord | undefined> { return (await this.database).get("partials", [datasetId, path]); }
  async checkpoint(datasetId: string, path: string, blob: Blob): Promise<void> {
    await (await this.database).put("partials", { datasetId, path, blob, bytes: blob.size });
  }
  async clearPartial(datasetId: string, path: string): Promise<void> { await (await this.database).delete("partials", [datasetId, path]); }
  async stage(datasetId: string, path: string, blob: Blob, digest: string): Promise<void> {
    const db = await this.database;
    const tx = db.transaction(["assets", "partials"], "readwrite");
    await Promise.all([
      tx.objectStore("assets").put({ datasetId, path, blob, sha256: digest, bytes: blob.size }),
      tx.objectStore("partials").delete([datasetId, path]),
      tx.done,
    ]);
  }
  async commit(manifest: PackManifest): Promise<void> {
    const db = await this.database;
    const tx = db.transaction(["assets", "installed", "downloads"], "readwrite");
    const assets = await Promise.all(manifest.assets.map((asset) => tx.objectStore("assets").get([manifest.datasetId, asset.path])));
    if (assets.some((asset, i) => !asset || asset.bytes !== manifest.assets[i]!.bytes || asset.sha256 !== manifest.assets[i]!.sha256)) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error("Some map files are missing. Resume the download to repair them.");
    }
    const now = Date.now();
    await Promise.all([
      tx.objectStore("installed").put({ regionId: manifest.regionId, datasetId: manifest.datasetId, manifest, installedAt: now }),
      tx.objectStore("downloads").put({ regionId: manifest.regionId, datasetId: manifest.datasetId, phase: "ready", downloadedBytes: manifest.totalBytes, totalBytes: manifest.totalBytes, updatedAt: now }),
      tx.done,
    ]);
  }
  async forgetInstallation(regionId: string, expectedDatasetId: string, expectedInstalledAt?: number): Promise<void> {
    const db = await this.database;
    const tx = db.transaction("installed", "readwrite");
    const current = await tx.store.get(regionId);
    if (current?.datasetId === expectedDatasetId && (expectedInstalledAt === undefined || current.installedAt === expectedInstalledAt)) await tx.store.delete(regionId);
    await tx.done;
  }
  async remove(regionId: string): Promise<void> {
    const db = await this.database;
    const tx = db.transaction(["installed", "downloads", "assets", "partials", "generations"], "readwrite");
    const [installed, download, generations] = await Promise.all([tx.objectStore("installed").get(regionId), tx.objectStore("downloads").get(regionId), tx.objectStore("generations").index("by-region").getAll(regionId)]);
    const ids = new Set([installed?.datasetId, download?.datasetId, ...generations.map((g) => g.datasetId)].filter((v): v is string => !!v));
    for (const name of ["assets", "partials"] as const) {
      for (const id of ids) {
        let cursor = await tx.objectStore(name).index("by-dataset").openCursor(id);
        while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
      }
    }
    await Promise.all([tx.objectStore("installed").delete(regionId), tx.objectStore("downloads").delete(regionId), ...[...ids].map((id) => tx.objectStore("generations").delete(id)), tx.done]);
  }
  async prune(datasetId: string): Promise<void> {
    const db = await this.database;
    const tx = db.transaction(["assets", "partials", "installed", "generations"], "readwrite");
    const active = await tx.objectStore("installed").getAll();
    if (active.some((pack) => pack.datasetId === datasetId)) { await tx.done; return; }
    for (const name of ["assets", "partials"] as const) {
      let cursor = await tx.objectStore(name).index("by-dataset").openCursor(datasetId);
      while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    }
    await tx.objectStore("generations").delete(datasetId);
    await tx.done;
  }
  async acquire(regionId: string, owner: string): Promise<boolean> {
    const db = await this.database;
    const tx = db.transaction("leases", "readwrite");
    const lease = await tx.store.get(regionId);
    if (lease && lease.owner !== owner && lease.expires > Date.now()) { await tx.done; return false; }
    await tx.store.put({ regionId, owner, expires: Date.now() + 45000 });
    await tx.done;
    return true;
  }
  async release(regionId: string, owner: string): Promise<void> {
    const db = await this.database;
    const tx = db.transaction("leases", "readwrite");
    if ((await tx.store.get(regionId))?.owner === owner) await tx.store.delete(regionId);
    await tx.done;
  }
}
