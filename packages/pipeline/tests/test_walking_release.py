import pytest
from graph import GraphBuilder
from roads import is_walkable, walking_access


@pytest.mark.parametrize("tags", [
    {"bridge":"pontoon"}, {"bridge":"floating"}, {"ford":"yes"},
    {"seasonal":"yes"}, {"seasonal":"summer"}, {"temporary":"yes"},
    {"foot:conditional":"no @ (sunset-sunrise)"},
    {"access:conditional":"no @ (Mo-Fr)"}, {"opening_hours":"Mo-Sa 08:00-18:00"},
])
def test_offline_walking_excludes_unverified_time_dependent_access(tags):
    assert not is_walkable({"highway":"footway", **tags})


def test_permanent_bridge_and_24_hour_access_are_kept():
    assert is_walkable({"highway":"footway", "bridge":"yes", "seasonal":"no", "opening_hours":"24/7"})
    assert not walking_access({"foot":"yes", "access:conditional":"no @ (wet)"})


def test_speed_changes_remain_junctions_for_edge_interior_navigation():
    graph=GraphBuilder(profile="walking")
    graph.add_way({"highway":"steps"},[1,2],[(25.44,81.83),(25.441,81.83)])
    graph.add_way({"highway":"footway"},[2,3],[(25.441,81.83),(25.442,81.83)])
    graph.simplify()
    assert 2 in graph.nodes
    steps=next(e for e in graph.edges if e.source==1 and e.target==2)
    footway=next(e for e in graph.edges if e.source==2 and e.target==3)
    assert steps.weight>footway.weight*1.8
