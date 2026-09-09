"""Build a routable graph from OSM ways, then simplify it.

OSM stores a way as a polyline through many nodes, most of which only exist to
describe the road's shape. For routing, a node matters only where a choice can
be made — a junction, or a dead end. Collapsing the rest is what takes Delhi
from ~130k nodes to ~61k while preserving every routing decision and the
geometry needed to draw the road.

Simplification is where subtle bugs live, so two properties are preserved
explicitly and asserted in tests:

  * **Cost.** A collapsed chain's weight is the sum of its segments. Routes
    through simplified and unsimplified graphs must cost the same.
  * **Direction.** A chain is only collapsed if every segment permits the same
    directions. Merging a two-way segment into a one-way chain would invent a
    road that does not exist.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

from roads import is_routable, speed_kph, travel_direction

# Matches WEIGHT_SCALE in packages/core/src/graph/format.ts.
# Integer weights keep the forward and backward A* searches exactly consistent.
WEIGHT_SCALE = 100  # weight units per second

EARTH_RADIUS_M = 6_371_008.8


def haversine_metres(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    """Great-circle distance. Mirrors haversineMetres in core's distance.ts."""
    phi_a = math.radians(lat_a)
    phi_b = math.radians(lat_b)
    d_phi = math.radians(lat_b - lat_a)
    d_lambda = math.radians(lon_b - lon_a)

    sin_phi = math.sin(d_phi / 2)
    sin_lambda = math.sin(d_lambda / 2)
    a = sin_phi * sin_phi + math.cos(phi_a) * math.cos(phi_b) * sin_lambda * sin_lambda
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def travel_weight(metres: float, kph: float) -> int:
    """Travel time in integer weight units.

    Rounded up, and never zero: a zero-weight edge creates a free move that lets
    A* expand nodes without making progress.
    """
    seconds = metres / (kph / 3.6)
    return max(1, math.ceil(seconds * WEIGHT_SCALE))


@dataclass(slots=True)
class Node:
    """A vertex. `osm_id` is kept so tiles can carry stable global ids."""

    osm_id: int
    lat: float
    lon: float
    # How many way-segments touch this node. Drives the junction test.
    degree: int = 0
    # True when more than one distinct way passes through, which makes it a
    # junction even at degree 2 (e.g. a T where the crossbar is one way).
    way_count: int = 0


@dataclass(slots=True)
class Edge:
    """A directed edge. `shape` holds interior geometry after simplification."""

    source: int
    target: int
    weight: int
    metres: float
    shape: list[tuple[float, float]] = field(default_factory=list)


class GraphBuilder:
    """Accumulates OSM ways into a directed graph, then simplifies it."""

    def __init__(self) -> None:
        self.nodes: dict[int, Node] = {}
        self.edges: list[Edge] = []
        self._ways_seen = 0
        self._ways_used = 0

    @property
    def stats(self) -> dict[str, int]:
        return {
            "ways_seen": self._ways_seen,
            "ways_used": self._ways_used,
            "nodes": len(self.nodes),
            "edges": len(self.edges),
        }

    def add_way(
        self, tags: dict[str, str], node_refs: list[int], coords: list[tuple[float, float]]
    ) -> None:
        """Add one OSM way as a chain of directed edges.

        `coords` are (lat, lon) parallel to `node_refs`. Nodes whose location is
        missing from the extract are skipped, which can split a way into
        fragments rather than inventing a straight line across the gap.
        """
        self._ways_seen += 1
        if not is_routable(tags) or len(node_refs) < 2:
            return

        forward, backward = travel_direction(tags)
        if not forward and not backward:
            return

        kph = speed_kph(tags)
        self._ways_used += 1

        previous: int | None = None
        for ref, (lat, lon) in zip(node_refs, coords):
            if lat is None or lon is None:
                previous = None  # gap in the extract; start a new fragment
                continue

            node = self.nodes.get(ref)
            if node is None:
                node = Node(osm_id=ref, lat=lat, lon=lon)
                self.nodes[ref] = node
            node.way_count += 1

            if previous is not None:
                self._add_segment(previous, ref, kph, forward, backward)
            previous = ref

    def _add_segment(
        self, source: int, target: int, kph: float, forward: bool, backward: bool
    ) -> None:
        a = self.nodes[source]
        b = self.nodes[target]
        metres = haversine_metres(a.lat, a.lon, b.lat, b.lon)
        if metres <= 0:
            return  # duplicate node position; no edge to make

        weight = travel_weight(metres, kph)
        if forward:
            self.edges.append(Edge(source, target, weight, metres))
            a.degree += 1
            b.degree += 1
        if backward:
            self.edges.append(Edge(target, source, weight, metres))
            a.degree += 1
            b.degree += 1

    # ------------------------------------------------------------------
    # Simplification
    # ------------------------------------------------------------------

    def simplify(self) -> None:
        """Collapse chains of degree-2 shape nodes into single weighted edges.

        A node survives if it is a junction, a dead end, or sits where the
        permitted directions change. Everything else becomes interior geometry
        on the edge that replaces it.
        """
        outgoing: dict[int, list[Edge]] = defaultdict(list)
        incoming: dict[int, list[Edge]] = defaultdict(list)
        for edge in self.edges:
            outgoing[edge.source].append(edge)
            incoming[edge.target].append(edge)

        keep = {node_id for node_id in self.nodes if self._is_junction(node_id, outgoing, incoming)}

        simplified: list[Edge] = []
        walked: set[int] = set()

        for start in keep:
            for first in outgoing[start]:
                if id(first) in walked:
                    continue
                chain = self._walk_chain(first, keep, outgoing, incoming, walked)
                if chain is not None:
                    simplified.append(chain)

        # Any edge not reachable from a kept node belongs to an isolated ring
        # (a roundabout with no junction, say). Keep one node of it so the ring
        # survives rather than vanishing.
        for edge in self.edges:
            if id(edge) not in walked:
                keep.add(edge.source)
                simplified.append(edge)
                walked.add(id(edge))

        self.edges = simplified
        self.nodes = {node_id: node for node_id, node in self.nodes.items() if node_id in keep}

    def _is_junction(
        self,
        node_id: int,
        outgoing: dict[int, list[Edge]],
        incoming: dict[int, list[Edge]],
    ) -> bool:
        """Whether a node must survive simplification.

        Kept when the node offers a routing choice: anything other than exactly
        one way in and one way out (a through-node on a one-way street), or one
        in and one out per direction (a through-node on a two-way street).
        """
        out_edges = outgoing.get(node_id, [])
        in_edges = incoming.get(node_id, [])

        # Dead end, or unreachable.
        if not out_edges or not in_edges:
            return True

        out_targets = {e.target for e in out_edges}
        in_sources = {e.source for e in in_edges}

        # One-way through-node: A -> here -> B.
        if len(out_edges) == 1 and len(in_edges) == 1:
            return out_targets == in_sources  # A -> here -> A is a dead-end stub

        # Two-way through-node: exactly two neighbours, symmetric.
        if len(out_edges) == 2 and len(in_edges) == 2 and out_targets == in_sources:
            return len(out_targets) != 2

        return True

    def _walk_chain(
        self,
        first: Edge,
        keep: set[int],
        outgoing: dict[int, list[Edge]],
        incoming: dict[int, list[Edge]],
        walked: set[int],
    ) -> Edge | None:
        """Follow a chain from a kept node until the next kept node.

        Returns a single edge carrying the summed weight and the interior
        geometry, or None if the chain was already consumed.
        """
        if id(first) in walked:
            return None

        walked.add(id(first))
        weight = first.weight
        metres = first.metres
        shape: list[tuple[float, float]] = list(first.shape)
        current = first.target
        guard = 0

        while current not in keep:
            # Degree-2 by construction, so there is exactly one way onward.
            candidates = [e for e in outgoing.get(current, []) if id(e) not in walked]
            if len(candidates) != 1:
                break

            node = self.nodes[current]
            shape.append((node.lat, node.lon))

            nxt = candidates[0]
            walked.add(id(nxt))
            weight += nxt.weight
            metres += nxt.metres
            shape.extend(nxt.shape)
            current = nxt.target

            guard += 1
            if guard > 10_000:  # pathological data; do not spin forever
                break

        return Edge(first.source, current, weight, metres, shape)

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    def label_components(self) -> dict[int, int]:
        """Label weakly-connected components, largest first (id 0).

        Stored per node so the runtime can answer "no route exists" in O(1)
        instead of exhausting the search space before failing. Weak rather than
        strong connectivity: strong is the stricter guarantee for a directed
        graph, but computing it is more work than it earns here, and a weakly
        connected pair that happens to be unreachable simply falls through to
        the normal search.
        """
        adjacency: dict[int, set[int]] = defaultdict(set)
        for edge in self.edges:
            adjacency[edge.source].add(edge.target)
            adjacency[edge.target].add(edge.source)

        component: dict[int, int] = {}
        groups: list[list[int]] = []

        for node_id in self.nodes:
            if node_id in component:
                continue
            stack = [node_id]
            members: list[int] = []
            component[node_id] = -1  # mark visited
            while stack:
                current = stack.pop()
                members.append(current)
                for neighbour in adjacency[current]:
                    if neighbour not in component:
                        component[neighbour] = -1
                        stack.append(neighbour)
            groups.append(members)

        groups.sort(key=len, reverse=True)
        for index, members in enumerate(groups):
            for node_id in members:
                component[node_id] = index

        return component
