/**
 * Geohash encoding.
 *
 * Must agree bit-for-bit with `packages/pipeline/geohash.py`. Tile keys cross
 * the pipeline/runtime boundary, so a disagreement means the runtime asks for
 * tiles the pipeline never wrote — silently unreachable roads rather than a
 * loud failure. `test/geohash.test.ts` pins both against shared vectors.
 *
 * Precision 6 gives ~1.22km x 0.61km cells: ~2000 tiles for Delhi NCT, and the
 * ~9 cells around a GPS fix load in ~60KB.
 */

/** base32 minus 'a', 'i', 'l', 'o' — the visually confusable characters. */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Reverse lookup, built once. */
const BASE32_INDEX = new Map<string, number>(
  [...BASE32].map((char, index) => [char, index]),
);

const LAT_MIN = -90;
const LAT_MAX = 90;
const LON_MIN = -180;
const LON_MAX = 180;

/** Cell size of the tiling scheme. Changing this invalidates every tile. */
export const TILE_PRECISION = 6;

export interface GeoBounds {
  readonly minLat: number;
  readonly minLon: number;
  readonly maxLat: number;
  readonly maxLon: number;
}

/**
 * Encode a coordinate to a geohash string.
 *
 * Interleaves longitude and latitude bits (longitude first), five bits per
 * output character.
 */
export function encodeGeohash(
  lat: number,
  lon: number,
  precision: number = TILE_PRECISION,
): string {
  let latLo = LAT_MIN;
  let latHi = LAT_MAX;
  let lonLo = LON_MIN;
  let lonHi = LON_MAX;

  let out = "";
  let bits = 0;
  let bitCount = 0;
  let even = true; // longitude on even bits

  while (out.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      if (lon > mid) {
        bits = (bits << 1) | 1;
        lonLo = mid;
      } else {
        bits <<= 1;
        lonHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat > mid) {
        bits = (bits << 1) | 1;
        latLo = mid;
      } else {
        bits <<= 1;
        latHi = mid;
      }
    }

    even = !even;
    bitCount++;

    if (bitCount === 5) {
      out += BASE32[bits]!;
      bits = 0;
      bitCount = 0;
    }
  }

  return out;
}

/**
 * The bounding box a geohash covers.
 *
 * Used to pick the tiles intersecting a route corridor before searching.
 */
export function geohashBounds(geohash: string): GeoBounds {
  let latLo = LAT_MIN;
  let latHi = LAT_MAX;
  let lonLo = LON_MIN;
  let lonHi = LON_MAX;
  let even = true;

  for (const char of geohash) {
    const index = BASE32_INDEX.get(char);
    if (index === undefined) {
      throw new Error(`invalid geohash character '${char}' in '${geohash}'`);
    }

    for (let shift = 4; shift >= 0; shift--) {
      const bit = (index >> shift) & 1;
      if (even) {
        const mid = (lonLo + lonHi) / 2;
        if (bit) lonLo = mid;
        else lonHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (bit) latLo = mid;
        else latHi = mid;
      }
      even = !even;
    }
  }

  return { minLat: latLo, minLon: lonLo, maxLat: latHi, maxLon: lonHi };
}

/**
 * The eight geohashes surrounding this one.
 *
 * Derived by re-encoding a point outside each edge rather than by base32
 * arithmetic on the hash string — the arithmetic form needs per-direction
 * border tables that are easy to get subtly wrong.
 */
export function geohashNeighbours(geohash: string): string[] {
  const { minLat, minLon, maxLat, maxLon } = geohashBounds(geohash);
  const latMid = (minLat + maxLat) / 2;
  const lonMid = (minLon + maxLon) / 2;
  const latStep = (maxLat - minLat) * 0.75;
  const lonStep = (maxLon - minLon) * 0.75;
  const precision = geohash.length;

  const out: string[] = [];
  for (const dLat of [latStep, 0, -latStep]) {
    for (const dLon of [-lonStep, 0, lonStep]) {
      if (dLat === 0 && dLon === 0) continue;
      const lat = Math.max(LAT_MIN, Math.min(LAT_MAX, latMid + dLat));
      let lon = lonMid + dLon;
      // Wrap longitude; the antimeridian is a real boundary, unlike the poles.
      if (lon > LON_MAX) lon -= 360;
      else if (lon < LON_MIN) lon += 360;
      out.push(encodeGeohash(lat, lon, precision));
    }
  }
  return out;
}

/**
 * Every geohash cell intersecting a bounding box.
 *
 * This is the corridor prefetch: given a source/target bbox dilated by a
 * margin, it returns the tiles to load before searching so the router never
 * blocks on IndexedDB mid-search.
 */
export function geohashesInBounds(
  bounds: GeoBounds,
  precision: number = TILE_PRECISION,
): string[] {
  // Step by one cell's dimensions, measured at the box's own latitude — cells
  // narrow toward the poles, so a globally-fixed step would miss tiles.
  const probe = geohashBounds(encodeGeohash(bounds.minLat, bounds.minLon, precision));
  const latStep = probe.maxLat - probe.minLat;
  const lonStep = probe.maxLon - probe.minLon;

  const seen = new Set<string>();
  for (let lat = bounds.minLat; lat <= bounds.maxLat + latStep; lat += latStep) {
    for (let lon = bounds.minLon; lon <= bounds.maxLon + lonStep; lon += lonStep) {
      seen.add(encodeGeohash(Math.min(lat, bounds.maxLat), Math.min(lon, bounds.maxLon), precision));
    }
  }
  return [...seen];
}
