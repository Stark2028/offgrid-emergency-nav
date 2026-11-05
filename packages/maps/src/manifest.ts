import { TILE_VERSION } from "@offgrid/core";

export type Bounds = readonly [west: number, south: number, east: number, north: number];
export interface MapDrawing {
  version: 1;
  bounds: Bounds;
  roads: Array<{ kind: string; points: Array<[number, number]> }>;
  labels: Array<{ text: string; point: [number, number] }>;
}
export interface Region {
  id: string;
  name: string;
  subtitle: string;
  coverageLabel: string;
  coverageType?: "starter" | "city-area";
  bounds: Bounds;
  areaKm2: number;
  totalBytes: number;
  datasetId: string;
  profile: "motor-v1" | "walking-v1";
  updatedAt: string;
  manifestUrl: string;
  manifestSha256: string;
  preview: MapDrawing;
}
export interface PackAsset {
  path: string;
  bytes: number;
  sha256: string;
  kind: "routing-tile" | "basemap";
}
export interface PackManifest {
  schemaVersion: 1;
  regionId: string;
  datasetId: string;
  profile: Region["profile"];
  tileVersion: number;
  bounds: Bounds;
  source: { name: string; url: string; timestamp: string; sha256: string; license: string };
  totalBytes: number;
  assets: PackAsset[];
}

export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_PACK_BYTES = 1024 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const CELL = "[0123456789bcdefghjkmnpqrstuvwxyz]{6}";
const PATH = new RegExp(`^(map\\.json|tiles/${CELL}\\.bin)$`);
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never { throw new Error(`Invalid map manifest: ${message}`); }
export function validBounds(value: unknown): value is Bounds {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return false;
  const [w, s, e, n] = value as number[];
  return w! >= -180 && e! <= 180 && s! >= -90 && n! <= 90 && w! < e! && s! < n!;
}
export function parseManifest(value: unknown, region: Region): PackManifest {
  if (!object(value) || value.schemaVersion !== 1) fail("unsupported schema");
  if (value.regionId !== region.id || value.datasetId !== region.datasetId ||
      typeof value.datasetId !== "string" || !HASH.test(value.datasetId)) fail("wrong region or generation");
  if (value.profile !== region.profile || value.tileVersion !== TILE_VERSION) fail("unsupported profile or tile version");
  if (!validBounds(value.bounds) || value.bounds.some((v, i) => v !== region.bounds[i])) fail("coverage differs from catalogue");
  if (!object(value.source) || value.source.name !== "OpenStreetMap contributors" ||
      typeof value.source.url !== "string" || !value.source.url.startsWith("https://") ||
      typeof value.source.timestamp !== "string" || !Number.isFinite(Date.parse(value.source.timestamp)) ||
      typeof value.source.sha256 !== "string" || !HASH.test(value.source.sha256) || value.source.license !== "ODbL-1.0") fail("missing source provenance");
  if (!Array.isArray(value.assets) || value.assets.length < 2 || value.assets.length > 20000) fail("invalid asset count");
  const paths = new Set<string>();
  let total = 0;
  let maps = 0;
  for (const asset of value.assets) {
    if (!object(asset) || typeof asset.path !== "string" || !PATH.test(asset.path) || paths.has(asset.path)) fail("unsafe or duplicate asset path");
    if (!Number.isSafeInteger(asset.bytes) || (asset.bytes as number) <= 0 || (asset.bytes as number) > MAX_ASSET_BYTES) fail("invalid asset size");
    if (typeof asset.sha256 !== "string" || !HASH.test(asset.sha256)) fail("invalid asset hash");
    if (asset.path === "map.json") {
      if (asset.kind !== "basemap") fail("wrong basemap type");
      maps++;
    } else if (asset.kind !== "routing-tile") fail("wrong tile type");
    paths.add(asset.path);
    total += asset.bytes as number;
  }
  if (maps !== 1 || total > MAX_PACK_BYTES || total !== value.totalBytes || total !== region.totalBytes) fail("size or basemap mismatch");
  return value as unknown as PackManifest;
}

export function parseDrawing(value: unknown): MapDrawing {
  if (!object(value) || value.version !== 1 || !validBounds(value.bounds) ||
      !Array.isArray(value.roads) || value.roads.length > 100000 || !Array.isArray(value.labels) || value.labels.length > 10000) throw new Error("The map drawing is invalid. Download the area again.");
  const point = (p: unknown): boolean => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  let count = 0;
  for (const road of value.roads) {
    if (!object(road) || typeof road.kind !== "string" || !Array.isArray(road.points) || road.points.length < 2 || !road.points.every(point)) throw new Error("The map contains an invalid road.");
    count += road.points.length;
    if (count > 500000) throw new Error("The map drawing exceeds the supported size.");
  }
  for (const label of value.labels) {
    if (!object(label) || typeof label.text !== "string" || label.text.length > 150 || !point(label.point)) throw new Error("The map contains an invalid label.");
  }
  return value as unknown as MapDrawing;
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Map verification requires HTTPS or localhost in a supported browser.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export function contains(bounds: Bounds, lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
}
