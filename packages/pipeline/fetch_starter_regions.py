"""Fetch bounded public OSM snapshots. Run deliberately; never from app startup."""
import json
import argparse
import gzip
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((Path(__file__).parent / "starter-regions.json").read_text())

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--region", choices=[region["id"] for region in CONFIG])
    parser.add_argument("--save-snapshots", action="store_true")
    args = parser.parse_args()
    output = ROOT / "data" / "raw"
    output.mkdir(parents=True, exist_ok=True)
    for region in CONFIG:
        if args.region and region["id"] != args.region:
            continue
        path = output / region["source"]
        if path.exists() and not args.refresh:
            print(f"keeping existing source: {path.name}", flush=True)
            continue
        west, south, east, north = region["bounds"]
        timeout = min(180, max(35, region.get("sourceTimeoutSeconds", 35)))
        bbox = f"({south},{west},{north},{east})"
        features = f"way[highway]{bbox};"
        if region.get("includePlaces"):
            features += f'node[place~"^(city|town|suburb|neighbourhood)$"]{bbox};node[railway=station]{bbox};node[amenity~"^(hospital|clinic|police|fire_station)$"]{bbox};'
        query = f"[out:json][timeout:{timeout}];({features});out body;>;out body qt;"
        request = urllib.request.Request("https://overpass-api.de/api/interpreter", data=urllib.parse.urlencode({"data": query}).encode(), headers={"User-Agent": "OFFGRID/0.1 bounded offline map build"})
        maximum = min(64 * 1024 * 1024, region.get("maxSourceBytes", 12 * 1024 * 1024))
        with urllib.request.urlopen(request, timeout=timeout + 30) as response:
            blob = response.read(maximum + 1)
        if len(blob) > maximum:
            raise ValueError("snapshot exceeds this region's source limit")
        parsed = json.loads(blob)
        if parsed.get("remark") or not parsed.get("elements"):
            raise ValueError("OSM source is incomplete; nothing was published")
        path.write_bytes(blob)
        if args.save_snapshots:
            snapshots = Path(__file__).parent / "snapshots"
            snapshots.mkdir(exist_ok=True)
            (snapshots / f"{region['source']}.gz").write_bytes(gzip.compress(blob, mtime=0))
        print(f"saved {path.name}: {len(blob):,} bytes", flush=True)
