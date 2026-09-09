"""Tests for road classification, speeds and oneway parsing.

Two invariants here protect routing correctness downstream:

  * no edge may exceed MAX_SPEED_KPH, or the A* heuristic stops being a lower
    bound and the router silently returns suboptimal paths;
  * oneway parsing must be exhaustive, or the graph routes people the wrong way
    up a street.

Both are tested exhaustively rather than by spot check.

    ./.venv/Scripts/python.exe -m pytest tests/ -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from roads import (  # noqa: E402
    HIGHWAY_SPEEDS,
    MAX_SPEED_KPH,
    is_routable,
    parse_maxspeed,
    speed_kph,
    travel_direction,
)


class TestSpeedBound:
    """The heuristic's admissibility rests entirely on this bound."""

    def test_every_table_speed_is_within_the_bound(self) -> None:
        for highway, speed in HIGHWAY_SPEEDS.items():
            assert speed <= MAX_SPEED_KPH, f"{highway} exceeds the heuristic bound"

    def test_absurd_maxspeed_tags_are_clamped(self) -> None:
        # Mistagged data must stay routable without breaking the bound.
        assert speed_kph({"highway": "residential", "maxspeed": "999"}) <= MAX_SPEED_KPH

    def test_mph_conversion_respects_the_bound(self) -> None:
        assert speed_kph({"highway": "motorway", "maxspeed": "500 mph"}) <= MAX_SPEED_KPH

    @pytest.mark.parametrize("highway", list(HIGHWAY_SPEEDS))
    def test_computed_speed_is_positive_and_bounded(self, highway: str) -> None:
        speed = speed_kph({"highway": highway})
        assert 0 < speed <= MAX_SPEED_KPH


class TestParseMaxspeed:
    def test_bare_number_is_kph(self) -> None:
        assert parse_maxspeed("50") == 50.0

    def test_mph_is_converted(self) -> None:
        assert parse_maxspeed("30 mph") == pytest.approx(48.28, abs=0.01)

    def test_walk_is_walking_pace(self) -> None:
        assert parse_maxspeed("walk") == 5.0

    @pytest.mark.parametrize("raw", [None, "", "none", "signals", "variable", "abc", "0", "-10"])
    def test_unusable_values_fall_through(self, raw: str | None) -> None:
        assert parse_maxspeed(raw) is None

    def test_country_speed_classes_fall_through(self) -> None:
        # Resolving IN:urban needs a jurisdiction table; the highway-class
        # default is both safer and closer to real traffic speed.
        assert parse_maxspeed("IN:urban") is None


class TestOneway:
    def test_absent_tag_is_bidirectional(self) -> None:
        assert travel_direction({"highway": "residential"}) == (True, True)

    @pytest.mark.parametrize("value", ["yes", "true", "1", "YES"])
    def test_forward_only(self, value: str) -> None:
        assert travel_direction({"highway": "primary", "oneway": value}) == (True, False)

    @pytest.mark.parametrize("value", ["-1", "reverse", "REVERSE"])
    def test_reverse_only(self, value: str) -> None:
        # The way is drawn against its direction of travel. Missing this routes
        # people the wrong way up a street.
        assert travel_direction({"highway": "primary", "oneway": value}) == (False, True)

    @pytest.mark.parametrize("value", ["no", "false", "0"])
    def test_explicit_no_is_bidirectional(self, value: str) -> None:
        assert travel_direction({"highway": "primary", "oneway": value}) == (True, True)

    def test_roundabouts_are_implicitly_oneway(self) -> None:
        assert travel_direction({"highway": "primary", "junction": "roundabout"}) == (True, False)

    def test_motorways_are_implicitly_oneway(self) -> None:
        assert travel_direction({"highway": "motorway"}) == (True, False)

    def test_explicit_tag_overrides_the_implicit_rule(self) -> None:
        # A dual-carriageway roundabout mapped as bidirectional must be honoured.
        tags = {"highway": "primary", "junction": "roundabout", "oneway": "no"}
        assert travel_direction(tags) == (True, True)

    def test_unrecognised_value_falls_back_to_implicit_rules(self) -> None:
        assert travel_direction({"highway": "motorway", "oneway": "garbage"}) == (True, False)


class TestRoutability:
    @pytest.mark.parametrize("highway", list(HIGHWAY_SPEEDS))
    def test_every_speed_table_entry_is_routable(self, highway: str) -> None:
        assert is_routable({"highway": highway})

    @pytest.mark.parametrize(
        "highway",
        ["footway", "cycleway", "steps", "path", "pedestrian", "track", "bridleway"],
    )
    def test_non_motor_ways_are_excluded(self, highway: str) -> None:
        assert not is_routable({"highway": highway})

    def test_missing_highway_tag_is_not_routable(self) -> None:
        assert not is_routable({"name": "Some Building"})

    @pytest.mark.parametrize("access", ["no", "private", "customers", "delivery"])
    def test_blocked_access_excludes_a_way(self, access: str) -> None:
        assert not is_routable({"highway": "service", "access": access})

    def test_motor_vehicle_permission_overrides_blanket_access_ban(self) -> None:
        tags = {"highway": "service", "access": "private", "motor_vehicle": "yes"}
        assert is_routable(tags)

    def test_motor_vehicle_ban_excludes_a_way(self) -> None:
        assert not is_routable({"highway": "residential", "motor_vehicle": "no"})

    def test_construction_is_excluded(self) -> None:
        assert not is_routable({"highway": "construction"})


class TestSurface:
    def test_unpaved_is_slower_than_paved(self) -> None:
        paved = speed_kph({"highway": "residential"})
        unpaved = speed_kph({"highway": "residential", "surface": "dirt"})
        assert unpaved < paved

    def test_explicit_maxspeed_wins_over_surface_penalty(self) -> None:
        # A signed limit is ground truth; our surface heuristic is a guess.
        assert speed_kph({"highway": "residential", "maxspeed": "40", "surface": "dirt"}) == 40.0
