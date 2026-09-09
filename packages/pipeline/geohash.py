"""Geohash encoding, deliberately hand-rolled.

This must agree bit-for-bit with the TypeScript implementation in
``packages/core/src/geo/geohash.ts``. Tile keys cross the pipeline/runtime
boundary, so a subtle disagreement between two library implementations would
mean tiles the runtime asks for and the pipeline never wrote — silently
unreachable roads rather than a loud failure.

Precision 6 gives ~1.22 km x 0.61 km cells. Delhi NCT (~1484 km^2) comes out
around 2000 tiles at roughly 7 KB each, so the ~9 cells around a GPS fix load
in ~60 KB.
"""

from __future__ import annotations

# Standard geohash alphabet: base32 with 'a', 'i', 'l', 'o' removed to avoid
# visually confusable characters.
BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

LAT_MIN, LAT_MAX = -90.0, 90.0
LON_MIN, LON_MAX = -180.0, 180.0


def encode(lat: float, lon: float, precision: int = 6) -> str:
    """Encode a coordinate to a geohash string.

    Interleaves longitude and latitude bits (longitude first), packing five
    bits per output character.
    """
    lat_lo, lat_hi = LAT_MIN, LAT_MAX
    lon_lo, lon_hi = LON_MIN, LON_MAX

    out: list[str] = []
    bits = 0
    bit_count = 0
    even = True  # longitude on even bits

    while len(out) < precision:
        if even:
            mid = (lon_lo + lon_hi) / 2
            if lon > mid:
                bits = (bits << 1) | 1
                lon_lo = mid
            else:
                bits <<= 1
                lon_hi = mid
        else:
            mid = (lat_lo + lat_hi) / 2
            if lat > mid:
                bits = (bits << 1) | 1
                lat_lo = mid
            else:
                bits <<= 1
                lat_hi = mid

        even = not even
        bit_count += 1

        if bit_count == 5:
            out.append(BASE32[bits])
            bits = 0
            bit_count = 0

    return "".join(out)


def bounds(geohash: str) -> tuple[float, float, float, float]:
    """Return the (min_lat, min_lon, max_lat, max_lon) box a geohash covers.

    Used to write each tile's bbox into its header, which the runtime reads to
    pick the tiles intersecting a route corridor.
    """
    lat_lo, lat_hi = LAT_MIN, LAT_MAX
    lon_lo, lon_hi = LON_MIN, LON_MAX
    even = True

    for char in geohash:
        index = BASE32.find(char)
        if index < 0:
            raise ValueError(f"invalid geohash character {char!r} in {geohash!r}")

        for shift in range(4, -1, -1):
            bit = (index >> shift) & 1
            if even:
                mid = (lon_lo + lon_hi) / 2
                if bit:
                    lon_lo = mid
                else:
                    lon_hi = mid
            else:
                mid = (lat_lo + lat_hi) / 2
                if bit:
                    lat_lo = mid
                else:
                    lat_hi = mid
            even = not even

    return lat_lo, lon_lo, lat_hi, lon_hi


def neighbours(geohash: str) -> list[str]:
    """The eight geohashes surrounding this one.

    Derived by re-encoding a point just outside each edge of the cell rather
    than by base32 arithmetic on the hash string: the arithmetic version needs
    per-direction border tables that are easy to get subtly wrong, and this
    runs once per tile at build time where the cost is irrelevant.
    """
    lat_lo, lon_lo, lat_hi, lon_hi = bounds(geohash)
    lat_mid = (lat_lo + lat_hi) / 2
    lon_mid = (lon_lo + lon_hi) / 2
    lat_step = (lat_hi - lat_lo) * 0.75
    lon_step = (lon_hi - lon_lo) * 0.75
    precision = len(geohash)

    out: list[str] = []
    for d_lat in (lat_step, 0.0, -lat_step):
        for d_lon in (-lon_step, 0.0, lon_step):
            if d_lat == 0.0 and d_lon == 0.0:
                continue
            lat = max(LAT_MIN, min(LAT_MAX, lat_mid + d_lat))
            lon = lon_mid + d_lon
            # Wrap longitude rather than clamping — the antimeridian is a real
            # boundary, unlike the poles.
            if lon > LON_MAX:
                lon -= 360.0
            elif lon < LON_MIN:
                lon += 360.0
            out.append(encode(lat, lon, precision))

    return out
