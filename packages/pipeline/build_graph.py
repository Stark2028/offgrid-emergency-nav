"""Turn an OSM extract into the binary geohash tiles the app routes on.

    ./.venv/Scripts/python.exe build_graph.py

Stages:
  1. read routable ways and their node coordinates from the PBF
  2. simplify — collapse degree-2 shape nodes into single weighted edges
  3. label weakly-connected components, so "no route" is an O(1) check
  4. serialise to geohash-6 tiles with duplicated boundary edges and halo nodes

The tile format is documented in packages/core/src/graph/format.ts.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import osmium

from graph import GraphBuilder
from tiles import build_tiles, write_tiles

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_INPUT = REPO_ROOT / "data" / "raw" / "delhi-roads.osm.pbf"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "tiles"


def load_ways(path: Path) -> GraphBuilder:
    """Stream routable ways into a graph.

    Uses osmium's location cache here — unlike the crop step, this file is small
    enough that indexing its nodes is cheap, and we genuinely need coordinates
    rather than just node ids.
    """
    builder = GraphBuilder()
    started = time.time()
    scanned = 0

    processor = (
        osmium.FileProcessor(str(path), osmium.osm.NODE | osmium.osm.WAY)
        .with_locations("flex_mem")
        .with_filter(osmium.filter.KeyFilter("highway").enable_for(osmium.osm.WAY))
    )

    for obj in processor:
        if not obj.is_way():
            continue

        scanned += 1
        if scanned % 100_000 == 0:
            print(f"  ...{scanned:,} ways, {time.time() - started:.0f}s", flush=True)

        refs: list[int] = []
        coords: list[tuple[float, float]] = []
        for node in obj.nodes:
            refs.append(node.ref)
            if node.location.valid():
                coords.append((node.location.lat, node.location.lon))
            else:
                # Missing from the extract — add_way fragments the way here
                # rather than drawing a straight line across the gap.
                coords.append((None, None))  # type: ignore[arg-type]

        builder.add_way(dict(obj.tags), refs, coords)

    print(f"  read {scanned:,} highway ways in {time.time() - started:.0f}s")
    return builder


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(
            f"missing input: {args.input}\n"
            "Run crop_extract.py first — see packages/pipeline/README.md"
        )

    overall = time.time()

    print(f"[1/4] reading {args.input.name}")
    builder = load_ways(args.input)
    raw = builder.stats
    print(f"      {raw['nodes']:,} nodes, {raw['edges']:,} directed edges")

    print("[2/4] simplifying")
    started = time.time()
    builder.simplify()
    simplified = builder.stats
    reduction = 100 * (1 - simplified["nodes"] / max(raw["nodes"], 1))
    print(
        f"      {simplified['nodes']:,} nodes ({reduction:.1f}% fewer), "
        f"{simplified['edges']:,} edges in {time.time() - started:.0f}s"
    )

    print("[3/4] labelling components")
    started = time.time()
    components = builder.label_components()
    component_count = len(set(components.values()))
    largest = sum(1 for value in components.values() if value == 0)
    print(
        f"      {component_count:,} components; largest holds "
        f"{largest:,} nodes ({100 * largest / max(len(components), 1):.1f}%) "
        f"in {time.time() - started:.0f}s"
    )

    print("[4/4] writing tiles")
    started = time.time()
    tiles = build_tiles(builder.nodes, builder.edges, components)
    stats = write_tiles(tiles, args.output)

    total_bytes = sum(stat.bytes_written for stat in stats)
    halo_total = sum(stat.halo_nodes for stat in stats)
    print(
        f"      {len(stats):,} tiles, {total_bytes / 1_000_000:.1f} MB total, "
        f"{total_bytes / max(len(stats), 1) / 1000:.1f} KB average "
        f"in {time.time() - started:.0f}s"
    )
    print(f"      {halo_total:,} halo entries across tile boundaries")

    manifest = {
        "version": 1,
        "precision": 6,
        "tiles": len(stats),
        "nodes": simplified["nodes"],
        "edges": simplified["edges"],
        "components": component_count,
        "bytes": total_bytes,
        "cells": sorted(stat.geohash for stat in stats),
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")

    print(f"done in {time.time() - overall:.0f}s -> {args.output}")


if __name__ == "__main__":
    main()
