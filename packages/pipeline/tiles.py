"""Serialise the graph into geohash-6 binary tiles.

The layout is documented in packages/core/src/graph/format.ts, which is the
contract this module writes against.

The hard part is tile boundaries. An edge whose endpoints fall in different
cells has to be usable from either side without loading the other tile first,
so:

  * every node carries a **global id**, not a tile-local index — local indices
    that need remapping on load are the main source of stitching bugs;
  * a boundary edge is written into **both** tiles, costing a few percent of
    size and removing a whole class of them;
  * the far endpoint appears in the neighbouring tile as a **halo node**: real
    coordinates (so the heuristic can be evaluated without loading the
    neighbour) but no outgoing adjacency. Settling one during search is the
    signal to load the owning tile and resume.
"""

from __future__ import annotations

import struct
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import geohash
from graph import Edge, Node

TILE_MAGIC = 0x4F475254  # "OGRT"
# Keep in step with TILE_VERSION in packages/core/src/graph/format.ts.
# Version 2: node ids are dense build-assigned indices, not OSM ids masked to
# u32. OSM ids exceed 2**32, so the mask was neither order-preserving nor
# injective -- it broke the runtime's binary search and allowed collisions.
TILE_VERSION = 2
HEADER_BYTES = 64
TILE_PRECISION = 6

NODE_FLAG_HALO = 1 << 0
NODE_FLAG_JUNCTION = 1 << 1

# High bit of a geometry reference: read the stored polyline back-to-front.
# A two-way road's forward and reverse edges describe the same physical shape,
# so they share one copy rather than storing it twice.
GEOMETRY_REVERSED = 0x80000000
GEOMETRY_OFFSET_MASK = 0x7FFFFFFF


@dataclass(slots=True)
class TileStats:
    geohash: str
    nodes: int
    halo_nodes: int
    forward_edges: int
    reverse_edges: int
    bytes_written: int


def pack_geohash(value: str) -> tuple[int, int]:
    """Pack a 6-character geohash into two u32s for the fixed-size header."""
    if len(value) != 6:
        raise ValueError(f"expected geohash-6, got {len(value)}: {value!r}")
    lo = value[0].encode()[0] | (value[1].encode()[0] << 8) | (value[2].encode()[0] << 16)
    hi = value[3].encode()[0] | (value[4].encode()[0] << 8) | (value[5].encode()[0] << 16)
    return lo, hi


def assign_tiles(nodes: dict[int, Node]) -> dict[int, str]:
    """Map each node to the geohash-6 cell that owns it."""
    return {
        node_id: geohash.encode(node.lat, node.lon, TILE_PRECISION)
        for node_id, node in nodes.items()
    }


def dense_id_map(nodes: dict[int, Node]) -> dict[int, int]:
    """OSM node id -> dense id, the value actually stored in tiles.

    Exposed because callers cannot reconstruct it: it depends on the full node
    set, not on any one tile. Test fixtures need it to describe expectations in
    the same id space the runtime reads.
    """
    return {osm_id: index for index, osm_id in enumerate(sorted(nodes))}


def build_tiles(
    nodes: dict[int, Node],
    edges: list[Edge],
    components: dict[int, int],
) -> dict[str, bytes]:
    """Serialise the graph into one binary blob per geohash cell."""
    owner = assign_tiles(nodes)

    # Which nodes each tile must describe: the ones it owns, plus halo entries
    # for the far end of every edge crossing its boundary.
    members: dict[str, set[int]] = defaultdict(set)
    for node_id, cell in owner.items():
        members[cell].add(node_id)

    # Boundary edges go into both tiles, so each side can traverse them without
    # first loading the other.
    tile_edges: dict[str, list[Edge]] = defaultdict(list)
    for edge in edges:
        source_cell = owner[edge.source]
        target_cell = owner[edge.target]

        tile_edges[source_cell].append(edge)
        members[source_cell].add(edge.target)  # halo if owned elsewhere

        if target_cell != source_cell:
            tile_edges[target_cell].append(edge)
            members[target_cell].add(edge.source)

    # Dense global ids.
    #
    # OSM node ids exceed 2**32 (the Delhi crop peaks at 14,162,787,060), so the
    # previous scheme -- sort the true ids, then mask each to u32 on write --
    # was doubly broken. Truncation does not preserve order, so the stored array
    # was not ascending and the runtime's binary search silently missed nodes
    # that were present; and the mask is not injective, so distinct nodes could
    # collide onto one stored id.
    #
    # Assigning a dense index ordered by true OSM id makes ascending order a
    # structural property of the format rather than a convention a later edit
    # can quietly break, and keeps the arrays u32 with no size cost.
    dense_of = dense_id_map(nodes)

    return {
        cell: _serialise_tile(
            cell, members[cell], tile_edges[cell], nodes, owner, components, dense_of
        )
        for cell in sorted(members)
    }


def _serialise_tile(
    cell: str,
    member_ids: set[int],
    cell_edges: list[Edge],
    nodes: dict[int, Node],
    owner: dict[int, str],
    components: dict[int, int],
    dense_of: dict[int, int],
) -> bytes:
    # Ordered by *dense* id so the stored array is ascending by construction --
    # see the note in build_tiles. Sorting by OSM id and truncating on write is
    # what produced an unsorted table and broke the runtime's binary search.
    ordered = sorted(member_ids, key=lambda node_id: dense_of[node_id])
    slot_of = {node_id: index for index, node_id in enumerate(ordered)}
    node_count = len(ordered)

    lat = bytearray()
    lon = bytearray()
    global_ids = bytearray()
    component_ids = bytearray()
    flags = bytearray()

    for node_id in ordered:
        node = nodes[node_id]
        lat += struct.pack("<f", node.lat)
        lon += struct.pack("<f", node.lon)
        global_ids += struct.pack("<I", dense_of[node_id])
        component_ids += struct.pack("<H", min(components.get(node_id, 0), 0xFFFF))

        flag = 0
        if owner[node_id] != cell:
            flag |= NODE_FLAG_HALO
        if node.way_count > 1:
            flag |= NODE_FLAG_JUNCTION
        flags += struct.pack("<B", flag)

    # Halo nodes get no outgoing adjacency: the tile that owns them describes
    # their edges. Settling one tells the router to load that tile.
    outgoing: dict[int, list[Edge]] = defaultdict(list)
    incoming: dict[int, list[Edge]] = defaultdict(list)
    for edge in cell_edges:
        if owner[edge.source] == cell:
            outgoing[edge.source].append(edge)
        if owner[edge.target] == cell:
            incoming[edge.target].append(edge)

    # Shapes are interned by the unordered node pair, so a two-way road's two
    # Edge objects — which are distinct objects carrying mirrored shapes — share
    # one stored copy and differ only in their direction tag.
    geometry = bytearray()
    shape_offsets: dict[tuple[int, int], int] = {}

    fwd_offsets, fwd_targets, fwd_weights, fwd_geometry = _pack_adjacency(
        ordered, outgoing, slot_of, geometry, shape_offsets, reverse=False
    )
    rev_offsets, rev_targets, rev_weights, rev_geometry = _pack_adjacency(
        ordered, incoming, slot_of, geometry, shape_offsets, reverse=True
    )

    fwd_edge_count = len(fwd_targets) // 4
    rev_edge_count = len(rev_targets) // 4

    # The runtime binary-searches this array (Tile.findSlot). A violation here
    # does not fail loudly -- it makes nodes that are present look absent, which
    # surfaced as routes containing steps with no edge behind them.
    dense_sequence = [dense_of[node_id] for node_id in ordered]
    if any(b <= a for a, b in zip(dense_sequence, dense_sequence[1:])):
        raise AssertionError(
            f"tile {cell}: stored node ids are not strictly ascending -- "
            "the runtime's binary search depends on this"
        )

    body = (
        bytes(lat)
        + bytes(lon)
        + bytes(global_ids)
        + bytes(component_ids)
        + bytes(flags)
    )
    body += b"\x00" * (-len(body) % 4)  # realign before the u32 arrays

    body += (
        bytes(fwd_offsets)
        + bytes(fwd_targets)
        + bytes(fwd_weights)
        + bytes(fwd_geometry)
        + bytes(rev_offsets)
        + bytes(rev_targets)
        + bytes(rev_weights)
        + bytes(rev_geometry)
    )

    geometry_offset = HEADER_BYTES + len(body)
    min_lat, min_lon, max_lat, max_lon = geohash.bounds(cell)
    lo, hi = pack_geohash(cell)

    header = bytearray(HEADER_BYTES)
    struct.pack_into("<I", header, 0, TILE_MAGIC)
    struct.pack_into("<I", header, 4, TILE_VERSION)
    struct.pack_into("<I", header, 8, node_count)
    struct.pack_into("<I", header, 12, fwd_edge_count)
    struct.pack_into("<I", header, 16, rev_edge_count)
    struct.pack_into("<I", header, 20, lo)
    struct.pack_into("<I", header, 24, hi)
    struct.pack_into("<I", header, 28, geometry_offset)
    struct.pack_into("<I", header, 32, len(geometry))
    struct.pack_into("<f", header, 36, min_lat)
    struct.pack_into("<f", header, 40, min_lon)
    struct.pack_into("<f", header, 44, max_lat)
    struct.pack_into("<f", header, 48, max_lon)

    return bytes(header) + bytes(body) + bytes(geometry)


def _pack_adjacency(
    ordered: list[int],
    adjacency: dict[int, list[Edge]],
    slot_of: dict[int, int],
    geometry: bytearray,
    shape_offsets: dict[tuple[int, int], int],
    *,
    reverse: bool,
) -> tuple[bytearray, bytearray, bytearray, bytearray]:
    """Pack one CSR adjacency (forward or reverse).

    The reverse direction is materialised rather than derived at runtime: the
    backward half of bidirectional A* must traverse edges pointing *into* a
    node, and deriving that on the fly is where one-way bugs come from.
    """
    offsets = bytearray()
    targets = bytearray()
    weights = bytearray()
    geometry_refs = bytearray()

    cursor = 0
    for node_id in ordered:
        offsets += struct.pack("<I", cursor)
        for edge in adjacency.get(node_id, []):
            far = edge.source if reverse else edge.target
            targets += struct.pack("<I", slot_of[far])
            weights += struct.pack("<I", min(edge.weight, 0xFFFFFFFF))
            geometry_refs += struct.pack(
                "<I", _geometry_ref(geometry, shape_offsets, edge, reverse=reverse)
            )
            cursor += 1

    offsets += struct.pack("<I", cursor)  # CSR sentinel
    return offsets, targets, weights, geometry_refs


def _geometry_ref(
    geometry: bytearray,
    shape_offsets: dict[tuple[int, int], int],
    edge: Edge,
    *,
    reverse: bool,
) -> int:
    """Reference to an edge's interior shape, appending it if new.

    Stored once as a u16 count followed by (lat, lon) float pairs. The high bit
    of the reference says to read the points back-to-front, so a two-way road's
    two edges share one copy — the shape is the same physical road either way.
    Storing both cost 40% of tile size, half of it redundant.

    Interning is keyed on the unordered node pair rather than object identity:
    GraphBuilder creates a separate Edge for each direction, so identity never
    matches. The stored copy is always oriented low-id to high-id, and any edge
    running the other way carries the reversed tag — which is independent of
    whether this is the forward or reverse CSR.
    """
    key = (min(edge.source, edge.target), max(edge.source, edge.target))
    stored_forward = edge.source <= edge.target

    offset = shape_offsets.get(key)
    if offset is None:
        offset = len(geometry)
        shape_offsets[key] = offset

        # Orient the stored copy low-id to high-id, whichever edge got here first.
        shape = edge.shape if stored_forward else list(reversed(edge.shape))
        shape = shape[:0xFFFF]
        geometry += struct.pack("<H", len(shape))
        for point_lat, point_lon in shape:
            geometry += struct.pack("<ff", point_lat, point_lon)

    # `reverse` says which CSR this entry belongs to; the geometry tag has to
    # describe travel direction along the stored shape instead. In the reverse
    # CSR the edge is traversed target-to-source, flipping that direction.
    travels_forward = stored_forward if not reverse else not stored_forward
    return offset if travels_forward else offset | GEOMETRY_REVERSED


def write_tiles(tiles: dict[str, bytes], out_dir: Path) -> list[TileStats]:
    """Write tiles to disk, one file per cell, and return per-tile stats."""
    out_dir.mkdir(parents=True, exist_ok=True)

    stats: list[TileStats] = []
    for cell, blob in tiles.items():
        path = out_dir / f"{cell}.bin"
        path.write_bytes(blob)

        node_count, fwd, rev = struct.unpack_from("<III", blob, 8)
        flags_offset = HEADER_BYTES + node_count * (4 + 4 + 4 + 2)
        halo = sum(
            1
            for index in range(node_count)
            if blob[flags_offset + index] & NODE_FLAG_HALO
        )
        stats.append(TileStats(cell, node_count, halo, fwd, rev, len(blob)))

    return stats
