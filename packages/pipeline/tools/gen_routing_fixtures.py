"""Generate routing fixtures: graphs with genuinely competing paths.

The tile fixtures in gen_tile_fixtures.py exist to test the *reader* -- a single
road, a T-junction, a one-way. They are too small to catch a routing bug. A
premature-termination bug in bidirectional A* only shows up when two paths of
near-equal cost compete, because that is the only time "the frontiers met"
differs from "no better path can exist".

A note on shape, learned the hard way. Simplification keeps a node only when it
offers a routing *choice*: exactly one in and one out (a one-way through-node),
or two symmetric neighbours (a two-way through-node), means no choice and the
node collapses into interior geometry. A first attempt at these fixtures built
chains and closed rings, which are exactly the shapes with no choice in them --
so a four-node detour collapsed to a single parallel edge, and a triangle
collapsed into self-loops.

The fix is structural: every node that must survive gets a **stub**, a short
dead-end spur giving it a third neighbour. Degree 3 is a genuine junction, which
is also how real road networks keep their intersections. Stubs are named in the
thousands (1001, 1002, ...) so they are easy to ignore when reading a fixture.

The cases are built to be adversarial:

  * ``grid``        -- a lattice where many equal-cost paths exist. Ties are
                       where tie-breaking bugs hide.
  * ``detour``      -- a direct one-way and a longer two-way bypass. The return
                       trip cannot use the direct road, so cost A->B != B->A.
  * ``asymmetric``  -- a one-way loop. Adjacent pairs cost differently in each
                       direction; opposite corners do not (two edges either way
                       round a 4-cycle). Four of six pairs differ, which is
                       enough to catch a backward search walking forward edges.
  * ``ladder``      -- two parallel rails of differing speed joined by rungs, so
                       the optimal path weaves between them.
  * ``bottleneck``  -- two clusters joined by a single bridge, forcing the
                       meeting point and pinning mu-bound termination.
  * ``escape``      -- a centre with four exits at different distances, for
                       multi-target search.

Each case records the *expected* costs, computed here by an independent Dijkstra
over the same graph, so the TypeScript tests assert against numbers derived from
the graph rather than from the implementation under test.

    ./.venv/Scripts/python.exe tools/gen_routing_fixtures.py
"""

from __future__ import annotations

import heapq
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graph import GraphBuilder, Edge  # noqa: E402
from tiles import build_tiles  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent.parent.parent / "core" / "test" / "fixtures" / "routing"

# Spacing between lattice nodes, in degrees. ~0.0008 deg latitude is ~90 m, so a
# grid stays inside one or two geohash-6 cells and the fixtures stay small.
STEP = 0.0008
BASE_LAT = 28.6000
BASE_LON = 77.2000

# Stub spur length: short enough never to be on an optimal route between real
# nodes, long enough to be a distinct coordinate.
STUB = STEP / 8

# Stub ids start here so real nodes stay readable in a fixture dump.
STUB_BASE = 1000


class Case:
    """A graph under construction, with stub bookkeeping."""

    def __init__(self) -> None:
        self.builder = GraphBuilder()
        self._next_stub = STUB_BASE

    def road(self, tags: dict[str, str], ids: list[int], coords: list[tuple[float, float]]) -> None:
        self.builder.add_way(tags, ids, coords)

    def anchor(self, node_id: int, lat: float, lon: float, spurs: int = 1) -> None:
        """Pin a node against simplification by giving it dead-end spurs.

        A degree-2 node offers no routing choice and collapses into the geometry
        of the edge that replaces it. One spur lifts it to degree 3.

        Dead ends need *two* spurs, not one. A tip already survives on its own,
        but a single spur turns it into a plain through-node (one neighbour each
        side) which then collapses -- the anchor makes things worse. Two spurs
        restore the branching that keeps it.
        """
        for _ in range(spurs):
            self._next_stub += 1
            offset = (self._next_stub - STUB_BASE) * STUB
            self.builder.add_way(
                {"highway": "residential"},
                [node_id, self._next_stub],
                [(lat, lon), (lat + offset, lon + offset)],
            )

    def is_stub(self, node_id: int) -> bool:
        return node_id > STUB_BASE


def grid() -> Case:
    """A 4x4 lattice. Many routes share the same optimal cost.

    Interior nodes are junctions already. The four corners are degree-2 and
    would collapse, so they get anchored -- corners are the interesting
    endpoints for a long diagonal route.
    """
    case = Case()
    size = 4

    def node_id(row: int, col: int) -> int:
        return row * size + col + 1

    def coord(row: int, col: int) -> tuple[float, float]:
        return (BASE_LAT + row * STEP, BASE_LON + col * STEP)

    for row in range(size):
        for col in range(size):
            if col + 1 < size:
                case.road(
                    {"highway": "residential"},
                    [node_id(row, col), node_id(row, col + 1)],
                    [coord(row, col), coord(row, col + 1)],
                )
            if row + 1 < size:
                case.road(
                    {"highway": "residential"},
                    [node_id(row, col), node_id(row + 1, col)],
                    [coord(row, col), coord(row + 1, col)],
                )

    for row, col in [(0, 0), (0, size - 1), (size - 1, 0), (size - 1, size - 1)]:
        lat, lon = coord(row, col)
        case.anchor(node_id(row, col), lat, lon)

    return case


def detour() -> Case:
    """A direct one-way and a longer two-way bypass.

    1->4 can take the direct road. 4->1 cannot, so it must use the bypass and
    costs more. A router that ignores edge direction gets the same answer both
    ways, and is wrong once.

    Midpoints are anchored so the two routes stay distinct paths through
    distinct nodes rather than collapsing into parallel edges.
    """
    case = Case()

    direct = [
        (BASE_LAT, BASE_LON),
        (BASE_LAT, BASE_LON + STEP),
        (BASE_LAT, BASE_LON + 2 * STEP),
        (BASE_LAT, BASE_LON + 3 * STEP),
    ]
    case.road({"highway": "primary", "oneway": "yes"}, [1, 2, 3, 4], direct)

    bypass = [
        (BASE_LAT, BASE_LON),
        (BASE_LAT - STEP, BASE_LON + STEP),
        (BASE_LAT - STEP, BASE_LON + 2 * STEP),
        (BASE_LAT, BASE_LON + 3 * STEP),
    ]
    case.road({"highway": "residential"}, [1, 10, 11, 4], bypass)

    # Anchor the interior nodes of both routes, and both endpoints.
    case.anchor(2, *direct[1])
    case.anchor(3, *direct[2])
    case.anchor(10, *bypass[1])
    case.anchor(11, *bypass[2])
    case.anchor(1, *direct[0], spurs=2)
    case.anchor(4, *direct[3], spurs=2)

    return case


def asymmetric() -> Case:
    """A one-way square: every edge traversable in one direction only.

    Adjacent pairs cost differently depending on direction (one hop with the
    flow, three against). Opposite corners cost the same either way, since that
    is two edges whichever way you go round -- so this catches a backward search
    that walks forward edges on four of six pairs, not all six.

    Each corner is anchored: a one-way through-node (one in, one out) collapses
    otherwise, and the whole ring would become a self-loop.
    """
    case = Case()
    ring = [
        (BASE_LAT, BASE_LON),
        (BASE_LAT + STEP, BASE_LON),
        (BASE_LAT + STEP, BASE_LON + STEP),
        (BASE_LAT, BASE_LON + STEP),
    ]
    ids = [1, 2, 3, 4]
    for i in range(4):
        j = (i + 1) % 4
        case.road({"highway": "primary", "oneway": "yes"}, [ids[i], ids[j]], [ring[i], ring[j]])

    for node_id, (lat, lon) in zip(ids, ring):
        case.anchor(node_id, lat, lon)

    return case


def ladder() -> Case:
    """Two parallel rails of differing speed, joined by rungs.

    The north rail is primary (fast), the south living_street (slow), so an
    optimal path crosses between them rather than committing to one side.

    Rung endpoints are junctions already (rail + rung = degree 3); only the two
    ends of each rail need anchoring.
    """
    case = Case()
    length = 5

    def north(i: int) -> tuple[float, float]:
        return (BASE_LAT + STEP, BASE_LON + i * STEP)

    def south(i: int) -> tuple[float, float]:
        return (BASE_LAT, BASE_LON + i * STEP)

    for i in range(length - 1):
        case.road({"highway": "primary"}, [i + 1, i + 2], [north(i), north(i + 1)])
        case.road(
            {"highway": "living_street"},
            [100 + i + 1, 100 + i + 2],
            [south(i), south(i + 1)],
        )

    for i in range(length):
        case.road({"highway": "residential"}, [i + 1, 100 + i + 1], [north(i), south(i)])

    return case


def bottleneck() -> Case:
    """Two clusters joined by a single bridge edge.

    Every cross-cluster route passes through the bridge, so the meeting point is
    forced -- which pins that termination does not stop before reaching it.

    Clusters are stars rather than rings: a closed ring of degree-2 nodes
    collapses into self-loops, which is not a routing test.
    """
    case = Case()

    # West cluster: a hub with three leaves.
    west_hub = (BASE_LAT, BASE_LON + STEP)
    for offset, leaf in enumerate([(BASE_LAT + STEP, BASE_LON), (BASE_LAT, BASE_LON), (BASE_LAT - STEP, BASE_LON)]):
        case.road({"highway": "residential"}, [3, 1 + offset * 100], [west_hub, leaf])

    # The bridge.
    east_hub = (BASE_LAT, BASE_LON + 3 * STEP)
    case.road({"highway": "primary"}, [3, 10], [west_hub, east_hub])

    # East cluster: another hub with three leaves.
    for offset, leaf in enumerate(
        [
            (BASE_LAT + STEP, BASE_LON + 4 * STEP),
            (BASE_LAT, BASE_LON + 4 * STEP),
            (BASE_LAT - STEP, BASE_LON + 4 * STEP),
        ]
    ):
        case.road({"highway": "residential"}, [10, 11 + offset * 100], [east_hub, leaf])

    return case


def escape() -> Case:
    """A centre with four exits at different distances.

    For multi-target search: seeded from every exit, each node should learn the
    cost to the *nearest* one, which is not the cost to any particular one.

    Spoke interiors are anchored so the differing spoke lengths survive as
    distinct nodes rather than collapsing to four edges of differing weight.
    """
    case = Case()
    centre = (BASE_LAT, BASE_LON)

    spokes = [
        (10, 1, (1, 0)),
        (20, 2, (0, 1)),
        (30, 3, (-1, 0)),
        (40, 4, (0, -1)),
    ]
    for base_id, length, (d_lat, d_lon) in spokes:
        ids = [1]
        coords = [centre]
        for step in range(1, length + 1):
            ids.append(base_id + step)
            coords.append((BASE_LAT + d_lat * step * STEP, BASE_LON + d_lon * step * STEP))
        case.road({"highway": "residential"}, ids, coords)

        # Interior spoke nodes need one spur; the tip is a dead end and needs
        # two, or the single spur turns it into a collapsible through-node.
        for node_id, (lat, lon) in zip(ids[1:-1], coords[1:-1]):
            case.anchor(node_id, lat, lon)
        case.anchor(ids[-1], *coords[-1], spurs=2)

    return case


CASES = {
    "grid": grid,
    "detour": detour,
    "asymmetric": asymmetric,
    "ladder": ladder,
    "bottleneck": bottleneck,
    "escape": escape,
}

# Escape targets: the tip of each spoke.
ESCAPE_EXITS = {"escape": [11, 22, 33, 44]}


def all_pairs(edges: list[Edge], nodes: list[int]) -> dict[str, int]:
    """Independent Dijkstra over the built graph, for every ordered pair.

    Deliberately a separate implementation from anything in packages/core: if
    both shared a bug, the fixture would agree with the bug.
    """
    adjacency: dict[int, list[tuple[int, int]]] = {n: [] for n in nodes}
    for edge in edges:
        adjacency[edge.source].append((edge.target, edge.weight))

    out: dict[str, int] = {}
    for source in nodes:
        distance: dict[int, int | None] = {n: None for n in nodes}
        distance[source] = 0
        queue: list[tuple[int, int]] = [(0, source)]
        while queue:
            cost, node = heapq.heappop(queue)
            known = distance[node]
            if known is not None and cost > known:
                continue
            for target, weight in adjacency[node]:
                candidate = cost + weight
                current = distance[target]
                if current is None or candidate < current:
                    distance[target] = candidate
                    heapq.heappush(queue, (candidate, target))
        for target in nodes:
            value = distance[target]
            if target != source and value is not None:
                out[f"{source}->{target}"] = value
    return out


def nearest_exit(edges: list[Edge], nodes: list[int], exits: list[int]) -> dict[str, int]:
    """Cost from each node to its nearest exit.

    Walks the reverse graph seeded from every exit at zero, which is exactly
    "distance to the closest of these" in one search.
    """
    reverse: dict[int, list[tuple[int, int]]] = {n: [] for n in nodes}
    for edge in edges:
        reverse[edge.target].append((edge.source, edge.weight))

    distance: dict[int, int | None] = {n: None for n in nodes}
    queue: list[tuple[int, int]] = []
    for exit_node in exits:
        if exit_node in distance:
            distance[exit_node] = 0
            heapq.heappush(queue, (0, exit_node))

    while queue:
        cost, node = heapq.heappop(queue)
        known = distance[node]
        if known is not None and cost > known:
            continue
        for source, weight in reverse[node]:
            candidate = cost + weight
            current = distance[source]
            if current is None or candidate < current:
                distance[source] = candidate
                heapq.heappush(queue, (candidate, source))

    return {str(n): d for n, d in distance.items() if d is not None}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUT_DIR.glob("*.bin"):
        stale.unlink()

    index: dict[str, dict] = {}
    failures: list[str] = []

    for name, make in CASES.items():
        case = make()
        builder = case.builder
        builder.simplify()
        components = builder.label_components()
        tiles = build_tiles(builder.nodes, builder.edges, components)

        # A self-loop means a ring collapsed onto itself: the case lost the
        # structure it was built to test. Fail loudly rather than emitting a
        # fixture that tests nothing.
        loops = [(e.source, e.target) for e in builder.edges if e.source == e.target]
        if loops:
            failures.append(f"{name}: {len(loops)} self-loop(s) after simplification")

        written: list[str] = []
        for cell, blob in tiles.items():
            filename = f"{name}.{cell}.bin"
            (OUT_DIR / filename).write_bytes(blob)
            written.append(filename)

        node_ids = sorted(builder.nodes)
        real_ids = [n for n in node_ids if not case.is_stub(n)]

        entry: dict = {
            "files": sorted(written),
            "cells": sorted(tiles),
            # Nodes that matter to a test; stubs exist only to shape the graph.
            "real": real_ids,
            "nodes": {
                str(node_id): {
                    "lat": node.lat,
                    "lon": node.lon,
                    "component": components[node_id],
                }
                for node_id, node in sorted(builder.nodes.items())
            },
            "edges": sorted(
                [{"source": e.source, "target": e.target, "weight": e.weight} for e in builder.edges],
                key=lambda e: (e["source"], e["target"]),
            ),
            "shortest": all_pairs(builder.edges, node_ids),
        }

        if name in ESCAPE_EXITS:
            exits = [e for e in ESCAPE_EXITS[name] if e in builder.nodes]
            if len(exits) != len(ESCAPE_EXITS[name]):
                failures.append(f"{name}: expected exits {ESCAPE_EXITS[name]}, survived {exits}")
            entry["exits"] = exits
            entry["toNearestExit"] = nearest_exit(builder.edges, node_ids, exits)

        index[name] = entry
        print(
            f"{name}: {len(tiles)} tile(s), {len(real_ids)} real nodes "
            f"(+{len(node_ids) - len(real_ids)} stubs), {len(builder.edges)} edges, "
            f"{len(entry['shortest'])} reachable pairs"
        )

    if failures:
        for failure in failures:
            print(f"  FAIL {failure}", file=sys.stderr)
        print("fixtures lost the structure they were built to test", file=sys.stderr)
        sys.exit(1)

    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"wrote fixtures to {OUT_DIR}")


if __name__ == "__main__":
    main()
