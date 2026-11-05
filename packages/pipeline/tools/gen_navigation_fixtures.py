"""Small, explicitly synthetic directed geometries for the app route adapter."""
import base64
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from graph import GraphBuilder
from tiles import build_tiles


def generate():
    cases = {}
    for name, ways in {
        "curved": [({}, [1, 2, 3, 4], [(28.6,77.2),(28.6005,77.2005),(28.6005,77.201),(28.6,77.2015)])],
        "oneway": [({"oneway:foot":"yes"}, [1,2], [(28.6,77.2),(28.6,77.202)])],
        "parallel": [
            ({},[1,2],[(28.6,77.2),(28.6,77.202)]),
            ({},[1,3,2],[(28.6,77.2),(28.602,77.201),(28.6,77.202)]),
            ({},[2,4],[(28.6,77.202),(28.6,77.204)]),
            ({},[1,5],[(28.6,77.2),(28.599,77.2)]),
        ],
        "islands": [({},[1,2],[(28.6,77.2),(28.6,77.202)]),({},[3,4],[(28.602,77.2),(28.602,77.202)])],
        "bounded": [
            ({"highway":"steps"},[1,2],[(28.6,77.2),(28.6,77.202)]),
            ({},[1,3,2],[(28.6,77.2),(28.6005,77.201),(28.6,77.202)]),
            ({},[1,4],[(28.6,77.2),(28.5999,77.2)]),
        ],
        "stacked": [
            ({},[1,2],[(28.6,77.2),(28.6,77.202)]),
            ({},[3,4],[(28.599,77.201),(28.601,77.201)]),
        ],
    }.items():
        builder=GraphBuilder(profile="walking")
        for tags,ids,points in ways:
            builder.add_way({"highway":"footway",**tags},ids,points)
        builder.simplify()
        tiles=build_tiles(builder.nodes,builder.edges,builder.label_components())
        cases[name]={"tiles":{cell:base64.b64encode(data).decode() for cell,data in tiles.items()}}
    out=Path(__file__).resolve().parents[2]/"maps/test/navigation-fixtures.json"
    out.write_text(json.dumps(cases,sort_keys=True,indent=2)+"\n",encoding="utf-8",newline="\n")
    print("Wrote navigation fixtures")

if __name__=="__main__": generate()
