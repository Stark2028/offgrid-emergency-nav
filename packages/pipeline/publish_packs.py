"""Build immutable starter packs and a hash-pinned application catalogue.

No network requests. Source snapshots must already exist. Each generation is
content-addressed; existing generations are preserved for rollback and clients.
"""
from __future__ import annotations

import hashlib
import gzip
import json
import math
from pathlib import Path

from graph import GraphBuilder
from roads import walking_access
from tiles import TILE_VERSION, build_tiles

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "apps" / "web"


def json_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def build_pack(region: dict, source_bytes: bytes) -> tuple[dict, dict[str, bytes]]:
    source = json.loads(source_bytes)
    if source.get("remark") or not source.get("elements"):
        raise ValueError("source response is incomplete")
    timestamp = source["osm3s"]["timestamp_osm_base"]
    nodes = {item["id"]: item for item in source["elements"] if item["type"] == "node"}
    ways = [item for item in source["elements"] if item["type"] == "way"]
    blocked = {
        node_id for node_id, item in nodes.items()
        if not walking_access(item.get("tags", {})) or item.get("tags", {}).get("barrier") in {"wall", "fence", "block"}
    }
    graph = GraphBuilder(profile="walking")
    roads = []
    labels = []
    seen_names = set()
    max_labels = min(5000, region.get("maxLabels", 24))
    if region.get("includePlaces"):
        for node in nodes.values():
            tags = node.get("tags", {})
            name = tags.get("name:en") or tags.get("name")
            w, s, e, n = region["bounds"]
            if name and name not in seen_names and (tags.get("place") or tags.get("railway") == "station" or tags.get("amenity") in {"hospital", "clinic", "police", "fire_station"}) and w < node["lon"] < e and s < node["lat"] < n:
                labels.append({"text": name[:100], "point": [node["lon"], node["lat"]]})
                seen_names.add(name)
                if len(labels) >= max_labels:
                    break
    for way in ways:
        refs = way["nodes"]
        if any(ref not in nodes for ref in refs):
            raise ValueError(f"way {way['id']} contains missing source nodes")
        tags = way.get("tags", {})
        coords = [(nodes[ref]["lat"], nodes[ref]["lon"]) if ref not in blocked else (None, None) for ref in refs]
        graph.add_way(tags, refs, coords)
        points = [[round(nodes[ref]["lon"], 7), round(nodes[ref]["lat"], 7)] for ref in refs]
        if len(points) < 2:
            continue
        roads.append({"kind": tags.get("highway", "road"), "points": points})
        name = tags.get("name:en") or tags.get("name")
        if name and name not in seen_names and len(labels) < max_labels and tags.get("highway") in {"primary", "secondary", "tertiary", "pedestrian", "residential"}:
            point = points[len(points) // 2]
            w, s, e, n = region["bounds"]
            if w < point[0] < e and s < point[1] < n:
                labels.append({"text": name[:100], "point": point})
                seen_names.add(name)
    graph.simplify()
    if not graph.nodes or not graph.edges:
        raise ValueError("no walking graph was built")
    tiles = build_tiles(graph.nodes, graph.edges, graph.label_components())
    drawing = {"version": 1, "bounds": region["bounds"], "roads": roads, "labels": labels}
    files = {f"tiles/{cell}.bin": blob for cell, blob in tiles.items()}
    files["map.json"] = json_bytes(drawing)
    if any(len(blob) > 32 * 1024 * 1024 for blob in files.values()):
        raise ValueError("an asset exceeds the mobile 32 MiB limit; split this region before publishing")
    if len(roads) > 100000 or sum(len(road["points"]) for road in roads) > 500000:
        raise ValueError("basemap exceeds the renderer limits; split this region before publishing")
    assets = [{"path": path, "bytes": len(blob), "sha256": digest(blob), "kind": "basemap" if path == "map.json" else "routing-tile"} for path, blob in sorted(files.items())]
    identity = {"regionId": region["id"], "profile": "walking-v1", "tileVersion": TILE_VERSION, "bounds": region["bounds"], "sourceSha256": digest(source_bytes), "assets": assets}
    generation = digest(json_bytes(identity))
    manifest = {
        "schemaVersion": 1, "regionId": region["id"], "datasetId": generation,
        "profile": "walking-v1", "tileVersion": TILE_VERSION, "bounds": region["bounds"],
        "source": {"name": "OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright", "timestamp": timestamp, "sha256": digest(source_bytes), "license": "ODbL-1.0"},
        "totalBytes": sum(len(blob) for blob in files.values()), "assets": assets,
    }
    files["manifest.json"] = json_bytes(manifest)
    w, s, e, n = region["bounds"]
    area = ((n - s) * 111.195) * ((e - w) * 111.195 * math.cos(math.radians((n + s) / 2)))
    # A lightweight vector preview is bundled with the shell. Full map files
    # remain behind the user's download action.
    preview = {**drawing, "roads": [{**road, "points": road["points"][::max(1, len(road["points"]) // 10)]} for road in roads if road["kind"] not in {"steps", "service"}][:400], "labels": labels[:8]}
    preview["roads"] = [road for road in preview["roads"] if len(road["points"]) >= 2]
    entry = {key: region[key] for key in ["id", "name", "subtitle", "coverageLabel", "bounds"]}
    if "coverageType" in region:
        entry["coverageType"] = region["coverageType"]
    entry.update({"areaKm2": round(area, 2), "totalBytes": manifest["totalBytes"], "datasetId": generation, "profile": "walking-v1", "updatedAt": timestamp, "manifestUrl": f"/packs/{region['id']}/{generation}/manifest.json", "manifestSha256": digest(files["manifest.json"]), "preview": preview})
    return entry, files


def publish() -> None:
    config = json.loads((Path(__file__).parent / "starter-regions.json").read_text())
    entries = []
    for region in config:
        source_path = ROOT / "data" / "raw" / region["source"]
        snapshot = Path(__file__).parent / "snapshots" / f"{region['source']}.gz"
        if not source_path.exists() and not snapshot.exists():
            print(f"not published: {region['id']} (source snapshot absent)")
            continue
        source_bytes = source_path.read_bytes() if source_path.exists() else gzip.decompress(snapshot.read_bytes())
        entry, files = build_pack(region, source_bytes)
        target = WEB / "public" / "packs" / region["id"] / entry["datasetId"]
        for name, blob in files.items():
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.read_bytes() != blob:
                raise ValueError("refusing to overwrite an immutable generation")
            path.write_bytes(blob)
        entries.append(entry)
        print(f"published {entry['id']}: {entry['totalBytes']:,} bytes, {len(files)-2} routing tiles", flush=True)
    if not entries:
        raise ValueError("no source snapshots available; catalogue left unchanged")
    catalogue = WEB / "src" / "generated" / "catalog.json"
    catalogue.parent.mkdir(parents=True, exist_ok=True)
    catalogue.write_bytes(json_bytes({"schemaVersion": 1, "regions": entries}))


if __name__ == "__main__":
    publish()
