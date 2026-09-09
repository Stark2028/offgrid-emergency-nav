"""Road classification, access rules and travel speeds.

Two invariants matter here, and both are enforced by tests rather than left to
review:

1. No speed may exceed ``MAX_SPEED_KPH``. The A* heuristic divides straight-line
   distance by that speed to get a lower bound on travel time; a single faster
   edge makes the bound invalid and A* silently returns suboptimal routes.

2. Oneway parsing must be exhaustive. A missed ``oneway=-1`` produces a graph
   that routes the wrong way up a street — the kind of bug that only shows up
   when someone follows the route.
"""

from __future__ import annotations

from typing import Final

# Must match MAX_SPEED_MPS in packages/core/src/geo/distance.ts
# (33.34 m/s = 120.02 km/h). The heuristic's admissibility depends on it.
MAX_SPEED_KPH: Final = 120.0

# Highway tags we route on. Excludes footway/cycleway/steps/path: the app routes
# for movement through a city under stress, and pedestrians can use the drivable
# network anyway. A pedestrian-only layer can be added later behind an edge flag.
#
# Also excludes highway=service — parking aisles, driveways and alleys behind
# buildings. They are 13.2% of Delhi's routable ways but carry almost no value
# for moving *through* a city, and each one adds junctions to the graph. Keeping
# them cost ~20% of tile size for routes nobody needs in an emergency.
# living_street stays: in Delhi those are real through-routes.
#
# Speeds are free-flow design speeds in km/h. They are deliberately optimistic:
# the heuristic needs an upper bound on speed, and real congestion only ever
# makes an edge slower, which keeps estimates admissible.
HIGHWAY_SPEEDS: Final[dict[str, float]] = {
    "motorway": 90.0,
    "motorway_link": 45.0,
    "trunk": 70.0,
    "trunk_link": 40.0,
    "primary": 55.0,
    "primary_link": 35.0,
    "secondary": 45.0,
    "secondary_link": 30.0,
    "tertiary": 35.0,
    "tertiary_link": 25.0,
    "unclassified": 30.0,
    "residential": 25.0,
    "living_street": 12.0,
    "road": 25.0,  # explicitly unclassified by the mapper
}

# Access values that make a way unusable regardless of its highway tag.
BLOCKED_ACCESS: Final[frozenset[str]] = frozenset(
    {"no", "private", "customers", "delivery", "agricultural", "forestry"}
)

# oneway values meaning "traversable in both directions".
ONEWAY_BIDIRECTIONAL: Final[frozenset[str]] = frozenset({"no", "false", "0"})

# oneway values meaning "forward only" (node order as drawn).
ONEWAY_FORWARD: Final[frozenset[str]] = frozenset({"yes", "true", "1"})

# oneway values meaning "backward only" — the way is drawn against its own
# direction of travel. Missing this case routes people the wrong way up a street.
ONEWAY_REVERSE: Final[frozenset[str]] = frozenset({"-1", "reverse"})


def is_routable(tags: dict[str, str]) -> bool:
    """Whether a way carries motor traffic we can route over."""
    highway = tags.get("highway")
    if highway not in HIGHWAY_SPEEDS:
        return False

    # A blanket access ban blocks the way unless motor traffic is re-permitted.
    if tags.get("access") in BLOCKED_ACCESS:
        if tags.get("motor_vehicle") not in {"yes", "designated", "permissive"}:
            return False

    if tags.get("motor_vehicle") in BLOCKED_ACCESS:
        return False

    # Ways under construction or proposed are not on the ground yet.
    if highway in {"construction", "proposed"}:
        return False
    if tags.get("construction") and highway == "construction":
        return False

    return True


def parse_maxspeed(raw: str | None) -> float | None:
    """Parse an OSM ``maxspeed`` value to km/h, or None if unusable.

    Handles bare numbers, explicit ``mph``, and ``walk``. Country-code speed
    classes (``IN:urban``) are ignored deliberately — resolving them needs a
    jurisdiction table, and falling back to the highway-class default is both
    safer and closer to real traffic speeds.
    """
    if not raw:
        return None

    value = raw.strip().lower()
    if value == "walk":
        return 5.0
    if value in {"none", "signals", "variable"}:
        return None

    parts = value.split()
    try:
        magnitude = float(parts[0])
    except (ValueError, IndexError):
        return None

    if magnitude <= 0:
        return None

    if len(parts) > 1 and parts[1] == "mph":
        magnitude *= 1.609344

    # Clamp rather than reject: a mistagged 999 km/h street should still be
    # routable, but must never break the heuristic's upper bound.
    return min(magnitude, MAX_SPEED_KPH)


def speed_kph(tags: dict[str, str]) -> float:
    """Travel speed for a way, in km/h. Never exceeds MAX_SPEED_KPH."""
    tagged = parse_maxspeed(tags.get("maxspeed"))
    if tagged is not None:
        return tagged

    highway = tags.get("highway", "")
    speed = HIGHWAY_SPEEDS.get(highway, 25.0)

    # Unpaved surfaces are materially slower, and Delhi has plenty of them.
    surface = tags.get("surface", "")
    if surface in {"unpaved", "gravel", "dirt", "ground", "sand", "mud", "grass"}:
        speed = min(speed, 20.0)
    elif surface in {"cobblestone", "sett", "pebblestone", "compacted"}:
        speed = min(speed, 25.0)

    return min(speed, MAX_SPEED_KPH)


def travel_direction(tags: dict[str, str]) -> tuple[bool, bool]:
    """Return ``(forward_allowed, backward_allowed)`` for a way.

    Oneway semantics, in precedence order:
      - ``oneway=-1``/``reverse``  -> backward only
      - ``oneway=yes``/``true``/``1`` -> forward only
      - ``oneway=no``/``false``/``0`` -> both, overriding implied rules
      - ``junction=roundabout``/``circular`` -> implicitly forward-only
      - ``highway=motorway`` -> implicitly forward-only
      - otherwise both
    """
    oneway = tags.get("oneway", "").strip().lower()

    if oneway in ONEWAY_REVERSE:
        return (False, True)
    if oneway in ONEWAY_FORWARD:
        return (True, False)
    if oneway in ONEWAY_BIDIRECTIONAL:
        return (True, True)

    # Implicit oneways, only when the tag is absent or unrecognised.
    if tags.get("junction", "").lower() in {"roundabout", "circular"}:
        return (True, False)
    if tags.get("highway") == "motorway":
        return (True, False)

    return (True, True)
