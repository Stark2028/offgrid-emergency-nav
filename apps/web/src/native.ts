import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { MapStore, type MapStorage, type PackManifest, type InstalledPack, type DownloadRecord } from '@offgrid/maps';

export const native = Capacitor.isNativePlatform();
interface StorageBridge { run(options: { op: string; [key: string]: unknown }): Promise<Record<string, any>> }
const storage = registerPlugin<StorageBridge>('OfflineStorage');
const CHUNK = 128 * 1024;
function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

/** Chunked bridge messages keep 32MB map files off the Android main thread. */
export class NativeMapStore implements MapStorage {
  async close() { /* One process-owned SQLite connection. */ }
  async snapshot(): Promise<{ installed: InstalledPack[]; downloads: DownloadRecord[] }> {
    return await storage.run({ op: 'snapshot' }) as { installed: InstalledPack[]; downloads: DownloadRecord[] };
  }
  async installed(regionId: string) { return (await this.snapshot()).installed.find(p => p.regionId === regionId); }
  async record(record: DownloadRecord) { await storage.run({ op: 'record', record }); }
  async register(manifest: PackManifest) {
    if (manifest.assets.length > 5000 || manifest.totalBytes > 64 * 1024 * 1024 || new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 1024 * 1024) throw new Error('This map exceeds the Android release limits. Choose a smaller area.');
    await storage.run({ op: 'register', manifest });
  }
  private async read(kind: string, datasetId: string, path: string) {
    const info = await storage.run({ op: 'info', kind, datasetId, path });
    if (!info.exists) return undefined;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < info.bytes; offset += CHUNK) {
      const part = await storage.run({ op: 'read', kind, datasetId, path, offset });
      parts.push(decode(part.data));
    }
    const blob = new Blob(parts);
    if (blob.size !== info.bytes) throw new Error('A saved map file is incomplete. Check offline files to repair it.');
    return { datasetId, path, blob, bytes: blob.size, sha256: String(info.sha256 ?? '') };
  }
  asset(datasetId: string, path: string) { return this.read('asset', datasetId, path); }
  async assets(datasetId: string, paths: readonly string[]) {
    const records: Array<Awaited<ReturnType<NativeMapStore['asset']>>> = [];
    while (records.length < paths.length) {
      const batch = await storage.run({ op: 'batch', datasetId, paths: paths.slice(records.length, records.length + 128) });
      if (!Array.isArray(batch.files) || !batch.files.length) throw new Error('Saved map files could not be read. Check offline files.');
      for (const file of batch.files) {
        if (file.path !== paths[records.length]) throw new Error('Saved map file order is invalid.');
        if (!file.exists) records.push(undefined);
        else if (file.data === undefined) records.push(await this.read('asset', datasetId, file.path));
        else {
          const blob = new Blob([decode(file.data)]);
          if (blob.size !== file.bytes) throw new Error('A saved map file is incomplete.');
          records.push({ datasetId, path: file.path, blob, bytes: blob.size, sha256: String(file.sha256) });
        }
      }
    }
    return records;
  }
  partial(datasetId: string, path: string) { return this.read('partial', datasetId, path); }
  private async write(kind: string, datasetId: string, path: string, blob: Blob, start: number) {
    // Each append is transactional. Any crash leaves a valid resumable prefix.
    for (let offset = start; offset < blob.size; offset += CHUNK) {
      const data = base64(new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer()));
      await storage.run({ op: 'write', kind, datasetId, path, offset, data });
    }
  }
  async checkpoint(datasetId: string, path: string, blob: Blob) {
    const info = await storage.run({ op: 'info', kind: 'partial', datasetId, path });
    let start = info.exists ? Number(info.bytes) : 0;
    if (start > blob.size || start % CHUNK) {
      await this.clearPartial(datasetId, path); start = 0;
    }
    await this.write('partial', datasetId, path, blob, start);
  }
  async clearPartial(datasetId: string, path: string) { await storage.run({ op: 'clear', kind: 'partial', datasetId, path }); }
  async stage(datasetId: string, path: string, blob: Blob, digest: string) {
    await storage.run({ op: 'clear', kind: 'pending', datasetId, path });
    await this.write('pending', datasetId, path, blob, 0);
    await storage.run({ op: 'finalize', datasetId, path, digest, bytes: blob.size });
  }
  async commit(manifest: PackManifest) { await storage.run({ op: 'commit', manifest }); }
  async forgetInstallation(regionId: string, expectedDatasetId: string, expectedInstalledAt?: number) { await storage.run({ op: 'forget', regionId, datasetId: expectedDatasetId, installedAt: expectedInstalledAt }); }
  async remove(regionId: string) { await storage.run({ op: 'remove', regionId }); }
  async prune(datasetId: string) { await storage.run({ op: 'prune', datasetId }); }
  async acquire(regionId: string, owner: string) { return Boolean((await storage.run({ op: 'acquire', regionId, owner })).acquired); }
  async release(regionId: string, owner: string) { await storage.run({ op: 'release', regionId, owner }); }
}
export function createMapStore(): MapStorage { return native ? new NativeMapStore() : new MapStore(); }
export async function availableBytes(): Promise<number | undefined> {
  if (native) return Number((await storage.run({ op: 'space' })).bytes);
  const estimate = await navigator.storage?.estimate();
  return estimate?.quota === undefined ? undefined : Math.max(0, estimate.quota - (estimate.usage ?? 0));
}
export async function currentPosition() {
  if (native) return Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
