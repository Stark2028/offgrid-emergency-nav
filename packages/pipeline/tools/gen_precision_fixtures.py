"""Cross-language precision regressions with independent shortest-path costs."""
import base64
import heapq
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from graph import GraphBuilder
from tiles import build_tiles, dense_id_map


def generate():
    rng = random.Random(31072026)
    cases = []
    for case in range(40):
        graph = GraphBuilder()
        coords = {i: (28.6000004 + rng.random() * .000012, 77.0000001 + rng.random() * .00002) for i in range(10)}
        for a in range(10):
            for b in range(10):
                if a != b and rng.random() < .27:
                    graph.add_way({"highway": "residential", "maxspeed": "120", "oneway": "yes"}, [a, b], [coords[a], coords[b]])
        graph.simplify()
        ids = dense_id_map(graph.nodes)
        adjacency = {node: [] for node in graph.nodes}
        for edge in graph.edges:
            adjacency[edge.source].append((edge.target, edge.weight))
        costs = {}
        for source in graph.nodes:
            distance = {source: 0}
            heap = [(0, source)]
            while heap:
                cost, node = heapq.heappop(heap)
                if cost != distance[node]:
                    continue
                for target, weight in adjacency[node]:
                    candidate = cost + weight
                    if candidate < distance.get(target, float("inf")):
                        distance[target] = candidate
                        heapq.heappush(heap, (candidate, target))
            for target, cost in distance.items():
                costs[f"{ids[source]}->{ids[target]}"] = cost
        tiles = build_tiles(graph.nodes, graph.edges, graph.label_components())
        cases.append({"case": case, "nodes": sorted(ids.values()), "tiles": {cell: base64.b64encode(blob).decode() for cell, blob in tiles.items()}, "costs": costs})
    output = Path(__file__).resolve().parents[2] / "core" / "test" / "fixtures" / "precision.json"
    output.write_text(json.dumps(cases, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(cases)} precision cases to {output.name}")


if __name__ == "__main__":
    generate()
