# OffGrid data pipeline

Turns an OpenStreetMap PBF extract into the binary geohash tiles the app routes on. Build-time only — nothing here ships to the browser.

## Setup

Python 3.10+.

```bash
cd packages/pipeline
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS/Linux
```

## Source data

Delhi sits in Geofabrik's India Northern Zone extract (~212 MB):

```bash
mkdir -p ../../data/raw
curl -o ../../data/raw/northern-zone.osm.pbf \
  https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf
```

`data/raw/` is gitignored — the extract is regenerated, not versioned.

## Why osmium rather than pyrosm

pyrosm is the better-known option and is genuinely fast, but it depends on `cykhash`, which has no Python 3.12 Windows wheel and needs a C++ toolchain to build. PyOsmium ships prebuilt wheels and suits us better anyway:

- We want a **routable graph**, not GeoDataFrames we would immediately tear apart into flat arrays.
- It **streams** nodes and ways, so memory stays constant regardless of extract size.
- Fewer dependencies, and no geopandas stack.

The convenience filtering pyrosm provides costs us a modest amount of explicit code.

## Geohash

`geohash.py` is hand-rolled rather than taken from PyPI. It must agree bit-for-bit with `packages/core/src/geo/geohash.ts`, because tile keys cross the pipeline/runtime boundary — a disagreement between two library implementations would mean the runtime requesting tiles the pipeline never wrote, surfacing as silently unreachable roads rather than an error.

The two are pinned together by shared test vectors in `packages/core/test/fixtures/geohash-vectors.json`, checked by `packages/core/test/geohash.test.ts`.

### Regenerating the vectors

Only needed if the encoding itself changes — which invalidates every existing tile.

```bash
cd packages/pipeline
./.venv/Scripts/python.exe tools/gen_geohash_vectors.py
```

Then re-run `pnpm --filter @offgrid/core test` to confirm both implementations still agree.
