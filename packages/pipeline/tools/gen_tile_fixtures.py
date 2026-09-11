"""Generate small binary tile fixtures for the TypeScript reader tests.

The point is cross-language verification: these are written by the real Python
serialiser, so the TS tests prove the reader handles bytes the pipeline
actually produces rather than bytes TypeScript produced for itself.

    ./.venv/Scripts/python.exe tools/gen_tile_fixtures.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import geohash  # noqa: E402
from graph import GraphBuilder  # noqa: E402
from tiles import build_tiles, dense_id_map  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent.parent.parent / "core" / "test" / "fixtures" / "tiles"


def single_cell() -> GraphBuilder:
    """A two-way road with interior shape nodes, all inside one cell."""
    builder = GraphBuilder()
    builder.add_way(
        {"highway": "residential"},
        [1, 2, 3, 4],
        [(28.6000, 77.2000), (28.6002, 77.2001), (28.6004, 77.2002), (28.6006, 77.2003)],
    )
    return builder


def junction() -> GraphBuilder:
    """A T-junction: a through road with a spur, so a node survives at degree 3."""
    builder = GraphBuilder()
    builder.add_way(
        {"highway": "primary"},
        [1, 2, 3],
        [(28.6000, 77.2000), (28.6005, 77.2000), (28.6010, 77.2000)],
    )
    builder.add_way(
        {"highway": "residential"},
        [2, 4],
        [(28.6005, 77.2000), (28.6005, 77.2010)],
    )
    return builder


def oneway() -> GraphBuilder:
    """A one-way street, to pin that forward and reverse adjacency differ."""
    builder = GraphBuilder()
    builder.add_way(
        {"highway": "primary", "oneway": "yes"},
        [1, 2, 3],
        [(28.6000, 77.2000), (28.6003, 77.2000), (28.6006, 77.2000)],
    )
    return builder


def crossing() -> GraphBuilder:
    """A road crossing a geohash boundary, producing halo nodes on both sides."""
    builder = GraphBuilder()
    builder.add_way(
        {"highway": "primary"},
        [1, 2],
        [(28.6000, 77.2000), (28.6000, 77.2400)],
    )
    return builder


def disconnected() -> GraphBuilder:
    """Two islands with no path between them, to exercise component ids."""
    builder = GraphBuilder()
    builder.add_way(
        {"highway": "residential"},
        [1, 2, 3],
        [(28.6000, 77.2000), (28.6002, 77.2000), (28.6004, 77.2000)],
    )
    builder.add_way(
        {"highway": "residential"},
        [10, 11],
        [(28.6020, 77.2020), (28.6022, 77.2020)],
    )
    return builder


CASES = {
    "single-cell": single_cell,
    "junction": junction,
    "oneway": oneway,
    "crossing": crossing,
    "disconnected": disconnected,
}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUT_DIR.glob("*.bin"):
        stale.unlink()

    index: dict[str, dict] = {}

    for name, make in CASES.items():
        builder = make()
        builder.simplify()
        components = builder.label_components()
        tiles = build_tiles(builder.nodes, builder.edges, components)

        written: list[str] = []
        for cell, blob in tiles.items():
            filename = f"{name}.{cell}.bin"
            (OUT_DIR / filename).write_bytes(blob)
            written.append(filename)

        # Expectations the TS tests assert against, derived from the same graph
        # the bytes came from.
        # Tiles store dense ids, not OSM ids (see tiles.py), so expectations
        # are keyed the same way the runtime reads them. osmId is kept for
        # anyone tracing a fixture back to the graph that produced it.
        dense = dense_id_map(builder.nodes)

        index[name] = {
            "files": sorted(written),
            "cells": sorted(tiles),
            "nodes": {
                str(dense[node_id]): {
                    "lat": node.lat,
                    "lon": node.lon,
                    "component": components[node_id],
                    "cell": geohash.encode(node.lat, node.lon, 6),
                    "osmId": node_id,
                }
                for node_id, node in sorted(builder.nodes.items())
            },
            "edges": sorted(
                [
                    {
                        "source": dense[e.source],
                        "target": dense[e.target],
                        "weight": e.weight,
                    }
                    for e in builder.edges
                ],
                key=lambda e: (e["source"], e["target"]),
            ),
        }
        print(f"{name}: {len(tiles)} tile(s), {len(builder.nodes)} nodes, {len(builder.edges)} edges")

    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"wrote fixtures to {OUT_DIR}")


if __name__ == "__main__":
    main()
