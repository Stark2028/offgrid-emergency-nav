import { Tile } from "@offgrid/core";
import { parseDrawing, parseManifest, sha256, type Bounds, type PackAsset, type PackManifest, type Region } from "./manifest.js";
import type { MapStorage, DownloadRecord, InstalledPack } from "./store.js";

export interface InstallProgress extends DownloadRecord { currentFile?: string }
export interface InstallerOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  onProgress?: (progress: InstallProgress) => void;
  availableBytes?: () => Promise<number | undefined>;
  /** Maximum time without a network response/chunk. Defaults to 30 seconds. */
  networkTimeoutMs?: number;
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, abort: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('The connection stopped responding. Your progress is saved; resume when connected.'));
        abort();
      }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function message(error: unknown): string {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return "There is not enough storage. Free some space, then resume the download.";
  return error instanceof Error ? error.message : "The download stopped. Check your connection and resume.";
}
async function readSmallResponse(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("The server returned an empty map manifest.");
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("The map manifest exceeds the supported size.");
      parts.push(new Uint8Array(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new Blob(parts).arrayBuffer();
}

/** A catalogue hash pins the manifest; verified files are committed as one generation. */
export class MapInstaller {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: URL;
  private readonly timeout: number;
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(readonly store: MapStorage, private readonly options: InstallerOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = options.networkTimeoutMs ?? 30000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0 || this.timeout > 120000) throw new RangeError('Invalid network timeout');
    this.baseUrl = new URL(options.baseUrl ?? (typeof location !== "undefined" ? location.origin : "http://localhost"));
  }
  install(region: Region): Promise<void> {
    if (this.running.has(region.id)) return Promise.reject(new Error("This area is already downloading."));
    const controller = new AbortController();
    const promise = this.perform(region, controller).finally(() => this.running.delete(region.id));
    this.running.set(region.id, { controller, promise });
    return promise;
  }
  async pause(regionId: string): Promise<void> {
    const run = this.running.get(regionId);
    run?.controller.abort(new DOMException("Download paused", "AbortError"));
    await run?.promise.catch(() => undefined);
  }
  async remove(regionId: string): Promise<void> {
    await this.pause(regionId);
    const owner = crypto.randomUUID();
    if (!await this.store.acquire(regionId, owner)) throw new Error("This area is being changed in another tab. Finish there, then try again.");
    try { await this.store.remove(regionId); }
    finally { await this.store.release(regionId, owner); }
  }
  async verify(regionId: string): Promise<InstalledPack> {
    const pack = await this.store.installed(regionId);
    if (!pack) throw new Error("This area has not been downloaded yet.");
    try {
      const records = await this.store.assets(pack.datasetId, pack.manifest.assets.map(a => a.path));
      for (const [index, asset] of pack.manifest.assets.entries()) {
        const saved = records[index];
        if (!saved || saved.blob.size !== asset.bytes) throw new Error("Some offline files are missing. Download the area again to repair it.");
        await this.validateAsset(asset, await saved.blob.arrayBuffer(), pack.manifest.bounds);
      }
    } catch (error) {
      // Losing readiness is explicit. The staged files remain available for repair.
      await this.store.forgetInstallation(regionId, pack.datasetId, pack.installedAt);
      throw error;
    }
    return pack;
  }
  private async validateAsset(asset: PackAsset, bytes: ArrayBuffer, bounds: Bounds): Promise<void> {
    if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error("A map file failed verification. Resume to download a clean copy.");
    if (asset.kind === "routing-tile") new Tile(bytes);
    else {
      const drawing = parseDrawing(JSON.parse(new TextDecoder().decode(bytes)));
      if (!drawing.bounds.every((value, index) => value === bounds[index])) throw new Error('The map boundary does not match its routing coverage. Download a corrected map pack.');
    }
  }
  private async perform(region: Region, controller: AbortController): Promise<void> {
    const owner = crypto.randomUUID();
    if (!await this.store.acquire(region.id, owner)) throw new Error("This area is downloading in another tab. You can resume here when that tab finishes.");
    let leaseLost = false;
    let leaseCheckedAt = Date.now();
    const guard = async (): Promise<void> => {
      const age = Date.now() - leaseCheckedAt;
      // A valid lease cannot be taken by another cooperating installer for
      // 45s. Refresh at most every 5s, including the heartbeat while waiting
      // on network I/O. Returning from suspension or a clock jump rechecks.
      if (!leaseLost && age >= 0 && age < 5000) return;
      if (!await this.store.acquire(region.id, owner)) {
        leaseLost = true;
        controller.abort();
        throw new Error("Another tab took over this download. Resume it in that tab.");
      }
      leaseCheckedAt = Date.now();
    };
    let heartbeatCheck = Promise.resolve();
    const heartbeat = setInterval(() => { heartbeatCheck = heartbeatCheck.then(guard).catch(() => controller.abort()); }, 12000);
    let downloaded = 0;
    let recordedAt = 0;
    let recordedPhase: DownloadRecord['phase'] | undefined;
    const update = async (phase: DownloadRecord["phase"], detail?: string, currentFile?: string): Promise<void> => {
      await guard();
      const record: InstallProgress = { regionId: region.id, datasetId: region.datasetId, phase, downloadedBytes: downloaded, totalBytes: region.totalBytes, updatedAt: Date.now(), ...(detail ? { message: detail } : {}), ...(currentFile ? { currentFile } : {}) };
      if (phase !== recordedPhase || Date.now() - recordedAt >= 500 || detail) {
        await this.store.record(record);
        recordedAt = Date.now(); recordedPhase = phase;
      }
      this.options.onProgress?.(record);
    };
    try {
      const manifestUrl = new URL(region.manifestUrl, this.baseUrl);
      if (manifestUrl.origin !== this.baseUrl.origin || !/^\/packs\/[a-z0-9-]+\/[a-f0-9]{64}\/manifest\.json$/.test(manifestUrl.pathname) || manifestUrl.search || manifestUrl.hash) throw new Error("The map catalogue contains an invalid download address.");
      const request = new AbortController();
      const requestSignal = AbortSignal.any([controller.signal, request.signal]);
      const response = await bounded(this.fetcher(manifestUrl, { signal: requestSignal, cache: "no-store" }), this.timeout, () => request.abort());
      if (!response.ok) throw new Error(`The map catalogue could not be reached (${response.status}). Check your connection and resume.`);
      const bytes = await bounded(readSmallResponse(response, 4 * 1024 * 1024), this.timeout, () => request.abort());
      if (await sha256(bytes) !== region.manifestSha256) throw new Error("The map manifest does not match this app's catalogue. Reload the app while online before trying again.");
      const manifest = parseManifest(JSON.parse(new TextDecoder().decode(bytes)), region);
      await guard();
      await this.store.register(manifest);
      const previous = await this.store.installed(region.id);
      const available = await this.options.availableBytes?.();
      if (available !== undefined && available < manifest.totalBytes * 1.25) throw new Error("There is not enough storage for this area. Free some space before downloading.");

      for (const asset of manifest.assets) {
        controller.signal.throwIfAborted();
        const saved = await this.store.asset(manifest.datasetId, asset.path);
        if (saved && saved.bytes === asset.bytes && saved.sha256 === asset.sha256) {
          try {
            await this.validateAsset(asset, await saved.blob.arrayBuffer(), manifest.bounds);
            downloaded += asset.bytes;
            await update("downloading");
            continue;
          } catch { /* Replace a damaged staged file using a fresh verified download. */ }
        }
        const completed = downloaded;
        await this.downloadAsset(manifest, asset, new URL(asset.path, manifestUrl), controller.signal, guard, async (received) => {
          downloaded = completed + received;
          await update("downloading", undefined, asset.path);
        });
        downloaded = completed + asset.bytes;
      }
      await update("verifying");
      // Re-read the complete staged generation before publishing its active pointer.
      const records = await this.store.assets(manifest.datasetId, manifest.assets.map(a => a.path));
      for (const [index, asset] of manifest.assets.entries()) {
        controller.signal.throwIfAborted();
        const saved = records[index];
        if (!saved) throw new Error("Some map files disappeared. Resume the download to repair them.");
        await this.validateAsset(asset, await saved.blob.arrayBuffer(), manifest.bounds);
      }
      await guard();
      controller.signal.throwIfAborted();
      await this.store.commit(manifest);
      this.options.onProgress?.({ regionId: region.id, datasetId: region.datasetId, phase: "ready", downloadedBytes: downloaded, totalBytes: region.totalBytes, updatedAt: Date.now() });
      if (previous && previous.datasetId !== manifest.datasetId) await this.store.prune(previous.datasetId).catch(() => undefined);
    } catch (error) {
      if (!leaseLost) {
        const paused = controller.signal.aborted;
        await update(paused ? "paused" : "error", paused ? "Download paused. Your progress is saved." : message(error)).catch(() => undefined);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      await heartbeatCheck;
      await this.store.release(region.id, owner);
    }
  }

  private async downloadAsset(manifest: PackManifest, asset: PackAsset, url: URL, signal: AbortSignal, guard: () => Promise<void>, progress: (bytes: number) => Promise<void>, allowRestart = true): Promise<void> {
    const partial = await this.store.partial(manifest.datasetId, asset.path);
    let blob = partial && partial.bytes <= asset.bytes && partial.blob.size === partial.bytes ? partial.blob : new Blob();
    let persisted = blob.size;
    let invalid = false;
    await progress(blob.size);
    const headers: Record<string, string> = blob.size ? { Range: `bytes=${blob.size}-` } : {};
    const request = new AbortController();
    const requestSignal = AbortSignal.any([signal, request.signal]);
    const response = await bounded(this.fetcher(url, { signal: requestSignal, cache: "no-store", headers }), this.timeout, () => request.abort());
    if (response.status === 200) {
      // Range is optional server behavior. Never append a whole 200 response to a prefix.
      blob = new Blob();
      persisted = 0;
      if (partial) await this.store.clearPartial(manifest.datasetId, asset.path);
    } else if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
      if (!range || Number(range[1]) !== blob.size || Number(range[2]) !== asset.bytes - 1 || Number(range[3]) !== asset.bytes) throw new Error("The server returned an invalid resumed download. Try again while connected.");
    } else if (response.status === 416 && blob.size === asset.bytes) {
      try { await this.validateAsset(asset, await blob.arrayBuffer(), manifest.bounds); }
      catch (error) {
        await guard();
        await this.store.clearPartial(manifest.datasetId, asset.path);
        if (allowRestart && !signal.aborted) return this.downloadAsset(manifest, asset, url, signal, guard, progress, false);
        throw error;
      }
      await guard();
      await this.store.stage(manifest.datasetId, asset.path, blob, asset.sha256);
      return;
    } else throw new Error(`A map file could not be downloaded (${response.status}). Check your connection and resume.`);
    if (!response.body) throw new Error("The server returned an empty map file. Resume to try again.");
    const reader = response.body.getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await bounded(reader.read(), this.timeout, () => request.abort());
        if (done) break;
        blob = new Blob([blob, new Uint8Array(value)]);
        if (blob.size > asset.bytes) { invalid = true; throw new Error("A downloaded map file is larger than expected. Resume to try again."); }
        if (blob.size - persisted >= 128 * 1024) {
          await guard();
          await this.store.checkpoint(manifest.datasetId, asset.path, blob);
          persisted = blob.size;
        }
        await progress(blob.size);
      }
      signal.throwIfAborted();
      if (blob.size !== asset.bytes) throw new Error("The connection ended before the map file finished. Your progress is saved; resume to continue.");
      try { await this.validateAsset(asset, await blob.arrayBuffer(), manifest.bounds); }
      catch (error) { invalid = true; throw error; }
      await guard();
      await this.store.stage(manifest.datasetId, asset.path, blob, asset.sha256);
    } catch (error) {
      await guard();
      if (invalid) {
        await this.store.clearPartial(manifest.datasetId, asset.path);
        if (allowRestart && !signal.aborted) {
          await reader.cancel().catch(() => undefined);
          return this.downloadAsset(manifest, asset, url, signal, guard, progress, false);
        }
      }
      else if (blob.size) await this.store.checkpoint(manifest.datasetId, asset.path, blob);
      throw error;
    } finally { await reader.cancel().catch(() => undefined); }
  }
}
