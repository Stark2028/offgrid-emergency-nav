"""Crop a regional OSM extract down to one city's road network.

Scanning the full 223 MB Northern Zone extract takes ~5 minutes per pass, and
the graph builder needs two. Cropping once to Delhi turns every later run into
a few seconds, which is the difference between a tight edit-test loop and not
having one.

Two passes:
  1. Collect the ids of every routable way inside the bounding box, and of every
     node those ways reference.
  2. Write exactly those nodes and ways to a new PBF.

The node set has to be gathered first because a way lists node ids, not
coordinates — and a way is only routable if we keep all of its nodes, including
the ones that fall marginally outside the box.

    ./.venv/Scripts/python.exe crop_extract.py
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import osmium

from roads import is_routable

# Delhi NCT, with a small margin so routes near the edge do not hit a wall.
DELHI_BBOX = (76.83, 28.40, 77.35, 28.90)  # west, south, east, north

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_INPUT = REPO_ROOT / "data" / "raw" / "northern-zone.osm.pbf"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "raw" / "delhi-roads.osm.pbf"


def collect_ids(
    path: Path, bbox: tuple[float, float, float, float]
) -> tuple[set[int], set[int]]:
    """Return (way_ids, node_ids) for routable ways intersecting the bbox.

    A way is kept if *any* of its nodes falls inside the box, so roads that
    cross the boundary stay whole rather than being clipped into dead ends.
    Requires node locations, so this pass runs with a location cache.
    """
    west, south, east, north = bbox
    way_ids: set[int] = set()
    node_ids: set[int] = set()

    started = time.time()
    scanned = 0

    # KeyFilter drops non-highway objects inside libosmium, before they cross
    # into Python — that is where most of the full-extract scan time goes.
    processor = (
        osmium.FileProcessor(str(path), osmium.osm.WAY)
        .with_locations("flex_mem")
        .with_filter(osmium.filter.KeyFilter("highway"))
    )

    for way in processor:
        scanned += 1
        if scanned % 200_000 == 0:
            print(f"  ...{scanned:,} highway ways, {time.time() - started:.0f}s", flush=True)

        if not is_routable(dict(way.tags)):
            continue

        nodes = way.nodes
        inside = False
        for node in nodes:
            if not node.location.valid():
                continue
            if west <= node.location.lon <= east and south <= node.location.lat <= north:
                inside = True
                break

        if inside:
            way_ids.add(way.id)
            for node in nodes:
                node_ids.add(node.ref)

    print(
        f"  pass 1: {scanned:,} highway ways scanned in {time.time() - started:.0f}s "
        f"-> {len(way_ids):,} routable ways, {len(node_ids):,} nodes"
    )
    return way_ids, node_ids


def write_subset(
    source: Path, dest: Path, way_ids: set[int], node_ids: set[int]
) -> None:
    """Write only the selected nodes and ways to a new PBF."""
    if dest.exists():
        dest.unlink()

    started = time.time()
    written_nodes = 0
    written_ways = 0

    writer = osmium.SimpleWriter(str(dest))
    try:
        for obj in osmium.FileProcessor(str(source), osmium.osm.NODE | osmium.osm.WAY):
            if obj.is_node():
                if obj.id in node_ids:
                    writer.add_node(obj)
                    written_nodes += 1
            elif obj.id in way_ids:
                writer.add_way(obj)
                written_ways += 1
    finally:
        writer.close()

    size_mb = dest.stat().st_size / 1_000_000
    print(
        f"  pass 2: wrote {written_nodes:,} nodes + {written_ways:,} ways "
        f"({size_mb:.1f} MB) in {time.time() - started:.0f}s"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--bbox",
        type=float,
        nargs=4,
        default=DELHI_BBOX,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
    )
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(
            f"missing input extract: {args.input}\n"
            "Download it first — see packages/pipeline/README.md"
        )

    print(f"cropping {args.input.name} to bbox {tuple(args.bbox)}")
    started = time.time()

    way_ids, node_ids = collect_ids(args.input, tuple(args.bbox))
    if not way_ids:
        raise SystemExit("no routable ways found in the bounding box — is it correct?")

    write_subset(args.input, args.output, way_ids, node_ids)
    print(f"done in {time.time() - started:.0f}s -> {args.output}")


if __name__ == "__main__":
    main()
