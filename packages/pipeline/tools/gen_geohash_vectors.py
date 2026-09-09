"""Regenerate the geohash vectors shared by the Python and TypeScript encoders.

The two implementations must agree bit-for-bit: tile keys cross the
pipeline/runtime boundary, so a disagreement means the runtime asks for tiles
the pipeline never wrote — silently unreachable roads rather than a loud
failure. These vectors are what pins them together.

Only run this if the encoding itself changes, which invalidates every tile
already built. Afterwards run `pnpm --filter @offgrid/core test`.

    ./.venv/Scripts/python.exe tools/gen_geohash_vectors.py
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import geohash  # noqa: E402

# Fixed so regenerating produces a reviewable diff rather than 200 changed lines.
SEED = 20260909
SAMPLE_COUNT = 200

# Delhi NCT bounding box.
DELHI_MIN_LAT, DELHI_MAX_LAT = 28.40, 28.90
DELHI_MIN_LON, DELHI_MAX_LON = 76.83, 77.35

# Cases worth pinning explicitly: the canonical vector from the geohash
# literature, the coordinate extremes, and the two demo-route landmarks.
FIXED_POINTS = [
    (57.64911, 10.40744),  # canonical reference -> u4pruy
    (0.0, 0.0),
    (-90.0, -180.0),
    (90.0, 180.0),
    (28.6315, 77.2167),  # Connaught Place
    (28.6129, 77.2295),  # India Gate
]

BOUNDS_CASES = ["ttnfv2", "u4pruy", "ezs42", "000000", "zzzzzz"]
NEIGHBOUR_CASES = ["ttnfv2", "u4pruy", "ezs42"]

OUTPUT = Path(__file__).resolve().parent.parent.parent / "core" / "test" / "fixtures" / "geohash-vectors.json"


def main() -> None:
    random.seed(SEED)

    encode_vectors = [
        {
            "lat": (lat := random.uniform(DELHI_MIN_LAT, DELHI_MAX_LAT)),
            "lon": (lon := random.uniform(DELHI_MIN_LON, DELHI_MAX_LON)),
            "hash": geohash.encode(lat, lon, 6),
        }
        for _ in range(SAMPLE_COUNT)
    ]
    encode_vectors += [
        {"lat": lat, "lon": lon, "hash": geohash.encode(lat, lon, 6)}
        for lat, lon in FIXED_POINTS
    ]

    payload = {
        "encode": encode_vectors,
        "bounds": [{"hash": h, "bounds": list(geohash.bounds(h))} for h in BOUNDS_CASES],
        "neighbours": [{"hash": h, "neighbours": geohash.neighbours(h)} for h in NEIGHBOUR_CASES],
    }

    # Guard against a silently broken encoder overwriting good vectors.
    canonical = geohash.encode(57.64911, 10.40744, 6)
    if canonical != "u4pruy":
        raise SystemExit(f"encoder is wrong: canonical vector gave {canonical!r}, expected 'u4pruy'")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=1), encoding="utf-8")

    print(f"wrote {len(encode_vectors)} encode vectors to {OUTPUT}")
    print(f"      {len(payload['bounds'])} bounds cases, {len(payload['neighbours'])} neighbour sets")


if __name__ == "__main__":
    main()
