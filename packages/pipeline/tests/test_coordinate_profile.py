import random
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import geohash
from graph import GraphBuilder, Node, canonical_coordinate, haversine_metres
from roads import is_walkable, walking_direction, walking_speed_kph
from tiles import assign_tiles, build_tiles


def test_ownership_matches_the_serialized_coordinate_at_a_boundary():
    _, west, north, east = geohash.bounds("ttnfsw")
    node = Node(1, north + 1e-7, (west + east) / 2)
    owner = assign_tiles({1: node})[1]
    blob = build_tiles({1: node}, [], {1: 0})[owner]
    lat, lon = struct.unpack_from("<ff", blob, 64)
    assert geohash.encode(lat, lon) == owner
    assert owner == "ttnfsw"


def test_maxspeed_weights_still_bound_distance_after_quantization():
    rng = random.Random(31072026)
    graph = GraphBuilder()
    for index in range(200):
        coords = [(28.6000004 + rng.random() * .000012, 77.0000001 + rng.random() * .00002) for _ in range(2)]
        graph.add_way({"highway": "residential", "maxspeed": "120"}, [index * 2, index * 2 + 1], coords)
    for edge in graph.edges:
        a, b = graph.nodes[edge.source], graph.nodes[edge.target]
        lower_bound = int(haversine_metres(a.lat, a.lon, b.lat, b.lon) / 33.34 * 100)
        assert edge.weight >= lower_bound


@pytest.mark.parametrize("highway", ["footway", "pedestrian", "steps", "service", "path"])
def test_walking_profile_includes_useful_pedestrian_links(highway):
    assert is_walkable({"highway": highway})


@pytest.mark.parametrize("highway", ["motorway", "motorway_link", "trunk", "construction"])
def test_walking_profile_excludes_high_speed_or_unbuilt_links(highway):
    assert not is_walkable({"highway": highway})


def test_walking_access_and_direction_are_independent_of_motor_traffic():
    assert not is_walkable({"highway": "footway", "foot": "no"})
    assert not is_walkable({"highway": "footway", "access": "private"})
    assert is_walkable({"highway": "footway", "access": "private", "foot": "yes"})
    assert is_walkable({"highway": "residential", "motor_vehicle": "no"})
    assert walking_direction({"oneway": "yes"}) == (True, True)
    assert walking_direction({"oneway:foot": "-1"}) == (False, True)
    assert walking_speed_kph({"highway": "steps", "maxspeed": "100"}) == 2.5
    graph = GraphBuilder(profile="walking")
    graph.add_way({"highway": "footway", "oneway": "yes"}, [1, 2], [(28.6, 77.2), (28.601, 77.2)])
    assert len(graph.edges) == 2


def test_coordinate_contract_rejects_nonfinite_values():
    with pytest.raises(ValueError):
        canonical_coordinate(float("nan"))
