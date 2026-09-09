"""Tests for binary tile serialisation.

Most of these are about tile boundaries, which is where the tiled design is
easiest to get wrong. An edge crossing from one cell to another must be usable
from either side without loading the other tile first, which means it is
written into both, and the far endpoint appears in the neighbour as a halo
node: real coordinates, no outgoing adjacency.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import geohash  # noqa: E402
from graph import GraphBuilder  # noqa: E402
from tiles import (  # noqa: E402
    HEADER_BYTES,
    NODE_FLAG_HALO,
    TILE_MAGIC,
    TILE_VERSION,
    assign_tiles,
    build_tiles,
    pack_geohash,
    write_tiles,
)


def read_header(blob: bytes) -> dict[str, int | float]:
    magic, version, nodes, fwd, rev, gh_lo, gh_hi, geo_off, geo_len = struct.unpack_from(
        "<IIIIIIIII", blob, 0
    )
    min_lat, min_lon, max_lat, max_lon = struct.unpack_from("<ffff", blob, 36)
    return {
        "magic": magic,
        "version": version,
        "nodes": nodes,
        "fwd": fwd,
        "rev": rev,
        "geometry_offset": geo_off,
        "geometry_bytes": geo_len,
        "min_lat": min_lat,
        "min_lon": min_lon,
        "max_lat": max_lat,
        "max_lon": max_lon,
    }


def node_flags(blob: bytes, node_count: int) -> list[int]:
    offset = HEADER_BYTES + node_count * (4 + 4 + 4 + 2)
    return list(blob[offset : offset + node_count])


def single_cell_graph() -> GraphBuilder:
    """A short two-way road entirely inside one geohash cell."""
    builder = GraphBuilder()
    builder.add_way(
        {"highway": "residential"},
        [1, 2, 3],
        [(28.6000, 77.2000), (28.6003, 77.2000), (28.6006, 77.2000)],
    )
    return builder


class TestPackGeohash:
    def test_roundtrips_through_the_header_encoding(self) -> None:
        lo, hi = pack_geohash("ttnfvh")
        recovered = "".join(
            chr((lo >> (i * 8)) & 0xFF) for i in range(3)
        ) + "".join(chr((hi >> (i * 8)) & 0xFF) for i in range(3))
        assert recovered == "ttnfvh"

    def test_rejects_wrong_length(self) -> None:
        with pytest.raises(ValueError, match="geohash-6"):
            pack_geohash("ttn")


class TestHeader:
    def test_writes_magic_and_version(self) -> None:
        builder = single_cell_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        blob = next(iter(tiles.values()))

        header = read_header(blob)
        assert header["magic"] == TILE_MAGIC
        assert header["version"] == TILE_VERSION

    def test_bbox_matches_the_cell(self) -> None:
        builder = single_cell_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        cell, blob = next(iter(tiles.items()))

        min_lat, min_lon, max_lat, max_lon = geohash.bounds(cell)
        header = read_header(blob)
        # float32 in the header, so compare loosely.
        assert header["min_lat"] == pytest.approx(min_lat, abs=1e-4)
        assert header["max_lon"] == pytest.approx(max_lon, abs=1e-4)

    def test_geometry_offset_is_inside_the_blob(self) -> None:
        builder = single_cell_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        blob = next(iter(tiles.values()))

        header = read_header(blob)
        assert header["geometry_offset"] + header["geometry_bytes"] == len(blob)


class TestSingleCell:
    def test_a_local_graph_produces_one_tile(self) -> None:
        builder = single_cell_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        assert len(tiles) == 1

    def test_no_halo_nodes_when_nothing_crosses(self) -> None:
        builder = single_cell_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        blob = next(iter(tiles.values()))

        header = read_header(blob)
        flags = node_flags(blob, int(header["nodes"]))
        assert all(not (flag & NODE_FLAG_HALO) for flag in flags)

    def test_forward_and_reverse_edge_counts_match_for_a_two_way_road(self) -> None:
        builder = single_cell_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        header = read_header(next(iter(tiles.values())))

        assert header["fwd"] == header["rev"]
        assert header["fwd"] > 0


class TestBoundaries:
    def crossing_graph(self) -> tuple[GraphBuilder, str, str]:
        """A road crossing a geohash boundary, plus the two cell names."""
        builder = GraphBuilder()
        # Step far enough east to land in a different precision-6 cell
        # (cells are ~1.22 km wide, so ~0.02 deg is comfortably over).
        west = (28.6000, 77.2000)
        east = (28.6000, 77.2400)
        builder.add_way({"highway": "primary"}, [1, 2], [west, east])

        cell_west = geohash.encode(*west, 6)
        cell_east = geohash.encode(*east, 6)
        assert cell_west != cell_east, "test setup must actually cross a boundary"
        return builder, cell_west, cell_east

    def test_a_crossing_edge_lands_in_both_tiles(self) -> None:
        builder, cell_west, cell_east = self.crossing_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())

        assert cell_west in tiles
        assert cell_east in tiles
        # Both sides must be able to traverse it without loading the other.
        assert read_header(tiles[cell_west])["fwd"] > 0
        assert read_header(tiles[cell_east])["fwd"] > 0

    def test_the_far_endpoint_is_a_halo_node(self) -> None:
        builder, cell_west, _ = self.crossing_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())

        header = read_header(tiles[cell_west])
        flags = node_flags(tiles[cell_west], int(header["nodes"]))
        assert sum(1 for flag in flags if flag & NODE_FLAG_HALO) == 1

    def test_halo_nodes_carry_real_coordinates(self) -> None:
        # The heuristic has to be evaluable without loading the neighbour.
        builder, cell_west, _ = self.crossing_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        blob = tiles[cell_west]

        header = read_header(blob)
        count = int(header["nodes"])
        lats = struct.unpack_from(f"<{count}f", blob, HEADER_BYTES)
        lons = struct.unpack_from(f"<{count}f", blob, HEADER_BYTES + count * 4)

        for lat, lon in zip(lats, lons):
            assert 28.0 < lat < 29.0
            assert 77.0 < lon < 78.0

    def test_halo_nodes_have_no_outgoing_edges(self) -> None:
        # Their owning tile describes their adjacency; settling one is the
        # signal to load that tile.
        builder, cell_west, _ = self.crossing_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())
        blob = tiles[cell_west]

        header = read_header(blob)
        count = int(header["nodes"])
        flags = node_flags(blob, count)

        body = HEADER_BYTES + count * (4 + 4 + 4 + 2 + 1)
        body += -body % 4  # the serialiser realigns before the u32 arrays
        offsets = struct.unpack_from(f"<{count + 1}I", blob, body)

        for index, flag in enumerate(flags):
            if flag & NODE_FLAG_HALO:
                assert offsets[index + 1] - offsets[index] == 0

    def test_every_node_is_assigned_to_the_cell_containing_it(self) -> None:
        builder, _, _ = self.crossing_graph()
        for node_id, cell in assign_tiles(builder.nodes).items():
            node = builder.nodes[node_id]
            min_lat, min_lon, max_lat, max_lon = geohash.bounds(cell)
            assert min_lat <= node.lat <= max_lat
            assert min_lon <= node.lon <= max_lon


class TestWriteTiles:
    def test_writes_one_file_per_cell(self, tmp_path: Path) -> None:
        builder, cell_west, cell_east = TestBoundaries().crossing_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())

        stats = write_tiles(tiles, tmp_path)
        written = {path.stem for path in tmp_path.glob("*.bin")}

        assert written == {cell_west, cell_east}
        assert len(stats) == 2

    def test_reported_sizes_match_the_files(self, tmp_path: Path) -> None:
        builder = single_cell_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())

        for stat in write_tiles(tiles, tmp_path):
            assert (tmp_path / f"{stat.geohash}.bin").stat().st_size == stat.bytes_written

    def test_counts_halo_nodes(self, tmp_path: Path) -> None:
        builder, _, _ = TestBoundaries().crossing_graph()
        tiles = build_tiles(builder.nodes, builder.edges, builder.label_components())

        stats = write_tiles(tiles, tmp_path)
        assert sum(stat.halo_nodes for stat in stats) == 2  # one per side
