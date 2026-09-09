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


def nodes_in_bbox(path: Path, bbox: tuple[float, float, float, float]) -> set[int]:
    """Ids of every node inside the bounding box.

    Deliberately avoids osmium's location cache. The cache resolves way-node
    coordinates, but it has to index all ~20M nodes in the extract to do it,
    which costs minutes and ~650 MB. Recording which node *ids* fall in the box
    answers the same question — "does this way touch Delhi?" — from the node
    pass we are making anyway.
    """
    west, south, east, north = bbox
    inside: set[int] = set()

    started = time.time()
    scanned = 0

    for node in osmium.FileProcessor(str(path), osmium.osm.NODE):
        scanned += 1
        if scanned % 5_000_000 == 0:
            print(f"  ...{scanned:,} nodes, {time.time() - started:.0f}s", flush=True)

        location = node.location
        if not location.valid():
            continue
        if west <= location.lon <= east and south <= location.lat <= north:
            inside.add(node.id)

    print(
        f"  pass 1: {scanned:,} nodes scanned in {time.time() - started:.0f}s "
        f"-> {len(inside):,} inside the bbox"
    )
    return inside


def collect_ids(
    path: Path, bbox_nodes: set[int]
) -> tuple[set[int], set[int]]:
    """Return (way_ids, node_ids) for routable ways touching the bbox.

    A way is kept if *any* of its nodes is inside, so roads crossing the
    boundary stay whole rather than being clipped into dead ends. All of a kept
    way's nodes are collected, including those outside the box.
    """
    way_ids: set[int] = set()
    node_ids: set[int] = set()

    started = time.time()
    scanned = 0

    # KeyFilter drops non-highway ways inside libosmium, before they cross into
    # Python — that is where most of the scan time would otherwise go.
    processor = osmium.FileProcessor(str(path), osmium.osm.WAY).with_filter(
        osmium.filter.KeyFilter("highway")
    )

    for way in processor:
        scanned += 1
        if scanned % 500_000 == 0:
            print(f"  ...{scanned:,} highway ways, {time.time() - started:.0f}s", flush=True)

        if not is_routable(dict(way.tags)):
            continue

        refs = [node.ref for node in way.nodes]
        if any(ref in bbox_nodes for ref in refs):
            way_ids.add(way.id)
            node_ids.update(refs)

    print(
        f"  pass 2: {scanned:,} highway ways scanned in {time.time() - started:.0f}s "
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
        f"  pass 3: wrote {written_nodes:,} nodes + {written_ways:,} ways "
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

    bbox_nodes = nodes_in_bbox(args.input, tuple(args.bbox))
    if not bbox_nodes:
        raise SystemExit("no nodes found in the bounding box — is it correct?")

    way_ids, node_ids = collect_ids(args.input, bbox_nodes)
    if not way_ids:
        raise SystemExit("no routable ways found in the bounding box — is it correct?")

    write_subset(args.input, args.output, way_ids, node_ids)
    print(f"done in {time.time() - started:.0f}s -> {args.output}")


if __name__ == "__main__":
    main()
