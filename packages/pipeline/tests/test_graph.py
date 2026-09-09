"""Tests for graph construction and simplification.

The property that matters: simplification must not change what any route costs
or which routes exist. A collapsed chain carries the summed weight of its
segments, and a chain is only collapsed when every segment permits the same
directions — merging a two-way segment into a one-way chain would invent a road
that is not there.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graph import (  # noqa: E402
    WEIGHT_SCALE,
    GraphBuilder,
    haversine_metres,
    travel_weight,
)

# A degree of latitude is ~111.32 km; small offsets give predictable distances.
LAT_STEP = 0.001  # ~111 m


def straight_way(count: int, *, lat: float = 28.6, lon: float = 77.2) -> tuple[list[int], list[tuple[float, float]]]:
    """A straight south-to-north chain of `count` nodes, ids 1..count."""
    refs = list(range(1, count + 1))
    coords = [(lat + i * LAT_STEP, lon) for i in range(count)]
    return refs, coords


def dijkstra(edges: list, source: int, target: int) -> int | None:
    """Shortest path cost, used as the oracle for simplification equivalence."""
    import heapq
    from collections import defaultdict

    adjacency: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for edge in edges:
        adjacency[edge.source].append((edge.target, edge.weight))

    distances = {source: 0}
    queue = [(0, source)]
    while queue:
        cost, node = heapq.heappop(queue)
        if node == target:
            return cost
        if cost > distances.get(node, float("inf")):
            continue
        for neighbour, weight in adjacency[node]:
            candidate = cost + weight
            if candidate < distances.get(neighbour, float("inf")):
                distances[neighbour] = candidate
                heapq.heappush(queue, (candidate, neighbour))
    return None


class TestHaversine:
    def test_zero_distance(self) -> None:
        assert haversine_metres(28.6, 77.2, 28.6, 77.2) == 0.0

    def test_one_degree_latitude_is_about_111km(self) -> None:
        assert haversine_metres(0.0, 0.0, 1.0, 0.0) == pytest.approx(111_195, rel=0.001)

    def test_is_symmetric(self) -> None:
        forward = haversine_metres(28.6129, 77.2295, 28.6315, 77.2167)
        backward = haversine_metres(28.6315, 77.2167, 28.6129, 77.2295)
        assert forward == pytest.approx(backward)


class TestTravelWeight:
    def test_scales_to_centiseconds(self) -> None:
        # 100 m at 36 km/h (10 m/s) = 10 s = 1000 weight units.
        assert travel_weight(100.0, 36.0) == 10 * WEIGHT_SCALE

    def test_is_never_zero(self) -> None:
        # A zero-weight edge is a free move that lets A* expand without progress.
        assert travel_weight(0.001, 120.0) >= 1

    def test_slower_speed_costs_more(self) -> None:
        assert travel_weight(1000.0, 20.0) > travel_weight(1000.0, 60.0)


class TestWayIngestion:
    def test_bidirectional_way_creates_edges_both_ways(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(2)
        builder.add_way({"highway": "residential"}, refs, coords)

        assert len(builder.nodes) == 2
        assert len(builder.edges) == 2
        assert {(e.source, e.target) for e in builder.edges} == {(1, 2), (2, 1)}

    def test_oneway_creates_a_single_direction(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(2)
        builder.add_way({"highway": "primary", "oneway": "yes"}, refs, coords)

        assert [(e.source, e.target) for e in builder.edges] == [(1, 2)]

    def test_reverse_oneway_points_backwards(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(2)
        builder.add_way({"highway": "primary", "oneway": "-1"}, refs, coords)

        assert [(e.source, e.target) for e in builder.edges] == [(2, 1)]

    def test_non_routable_ways_are_skipped(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(2)
        builder.add_way({"highway": "footway"}, refs, coords)

        assert builder.stats["ways_used"] == 0
        assert not builder.edges

    def test_duplicate_positions_produce_no_edge(self) -> None:
        builder = GraphBuilder()
        builder.add_way({"highway": "residential"}, [1, 2], [(28.6, 77.2), (28.6, 77.2)])
        assert not builder.edges

    def test_missing_coordinates_split_the_way(self) -> None:
        # A node absent from the extract must not become a straight line across
        # the gap; the way fragments instead.
        builder = GraphBuilder()
        coords = [(28.600, 77.2), (None, None), (28.602, 77.2)]
        builder.add_way({"highway": "residential", "oneway": "yes"}, [1, 2, 3], coords)
        assert not builder.edges


class TestSimplification:
    def test_collapses_a_straight_chain(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(5)
        builder.add_way({"highway": "residential", "oneway": "yes"}, refs, coords)

        assert len(builder.nodes) == 5
        builder.simplify()

        # Only the endpoints survive; the three interior shape nodes collapse.
        assert set(builder.nodes) == {1, 5}
        assert len(builder.edges) == 1

    def test_preserves_total_cost(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(6)
        builder.add_way({"highway": "residential", "oneway": "yes"}, refs, coords)

        before = dijkstra(builder.edges, 1, 6)
        builder.simplify()
        after = dijkstra(builder.edges, 1, 6)

        assert before is not None
        assert after == before

    def test_retains_interior_geometry(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(5)
        builder.add_way({"highway": "residential", "oneway": "yes"}, refs, coords)
        builder.simplify()

        # The road still has to be drawable: three interior points survive as
        # shape on the collapsed edge.
        assert len(builder.edges[0].shape) == 3

    def test_keeps_junctions(self) -> None:
        builder = GraphBuilder()
        # Main road 1-2-3, with a spur joining at node 2.
        builder.add_way(
            {"highway": "residential", "oneway": "yes"},
            [1, 2, 3],
            [(28.600, 77.2), (28.601, 77.2), (28.602, 77.2)],
        )
        builder.add_way(
            {"highway": "residential", "oneway": "yes"},
            [2, 4],
            [(28.601, 77.2), (28.601, 77.201)],
        )
        builder.simplify()

        assert 2 in builder.nodes, "a junction must survive simplification"

    def test_keeps_dead_ends(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(3)
        builder.add_way({"highway": "residential", "oneway": "yes"}, refs, coords)
        builder.simplify()

        assert 1 in builder.nodes and 3 in builder.nodes

    def test_bidirectional_chain_collapses_in_both_directions(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(4)
        builder.add_way({"highway": "residential"}, refs, coords)

        forward_before = dijkstra(builder.edges, 1, 4)
        backward_before = dijkstra(builder.edges, 4, 1)
        builder.simplify()

        assert dijkstra(builder.edges, 1, 4) == forward_before
        assert dijkstra(builder.edges, 4, 1) == backward_before

    def test_does_not_merge_across_a_direction_change(self) -> None:
        # A two-way segment feeding a one-way segment: collapsing them would
        # invent a two-way road where the second half is one-way.
        builder = GraphBuilder()
        builder.add_way(
            {"highway": "residential"},
            [1, 2],
            [(28.600, 77.2), (28.601, 77.2)],
        )
        builder.add_way(
            {"highway": "residential", "oneway": "yes"},
            [2, 3],
            [(28.601, 77.2), (28.602, 77.2)],
        )
        builder.simplify()

        # 3 -> 1 must remain impossible.
        assert dijkstra(builder.edges, 3, 1) is None
        # 1 -> 3 must remain possible.
        assert dijkstra(builder.edges, 1, 3) is not None

    def test_is_idempotent(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(6)
        builder.add_way({"highway": "residential", "oneway": "yes"}, refs, coords)

        builder.simplify()
        nodes_once, edges_once = len(builder.nodes), len(builder.edges)
        builder.simplify()

        assert (len(builder.nodes), len(builder.edges)) == (nodes_once, edges_once)

    def test_isolated_ring_survives(self) -> None:
        # A roundabout with nothing attached has no junction to anchor a walk;
        # it must not silently vanish.
        builder = GraphBuilder()
        builder.add_way(
            {"highway": "residential", "junction": "roundabout"},
            [1, 2, 3, 1],
            [(28.600, 77.200), (28.601, 77.200), (28.601, 77.201), (28.600, 77.200)],
        )
        builder.simplify()

        assert builder.edges, "an isolated ring must not disappear"


class TestComponents:
    def test_single_component_is_labelled_zero(self) -> None:
        builder = GraphBuilder()
        refs, coords = straight_way(3)
        builder.add_way({"highway": "residential"}, refs, coords)

        components = builder.label_components()
        assert set(components.values()) == {0}

    def test_largest_component_gets_id_zero(self) -> None:
        builder = GraphBuilder()
        # Big island: 4 nodes.
        builder.add_way(
            {"highway": "residential"},
            [1, 2, 3, 4],
            [(28.600 + i * 0.001, 77.2) for i in range(4)],
        )
        # Small island: 2 nodes, far away.
        builder.add_way(
            {"highway": "residential"},
            [10, 11],
            [(28.700, 77.3), (28.701, 77.3)],
        )

        components = builder.label_components()
        assert components[1] == 0, "the largest component should be id 0"
        assert components[10] != 0
        assert components[10] == components[11]

    def test_disconnected_nodes_get_distinct_ids(self) -> None:
        builder = GraphBuilder()
        builder.add_way({"highway": "residential"}, [1, 2], [(28.600, 77.2), (28.601, 77.2)])
        builder.add_way({"highway": "residential"}, [5, 6], [(28.700, 77.3), (28.701, 77.3)])

        components = builder.label_components()
        assert components[1] != components[5]
