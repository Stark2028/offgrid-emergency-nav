import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_packs import build_pack


def snapshot():
    return json.dumps({"osm3s": {"timestamp_osm_base": "2026-10-01T00:00:00Z"}, "elements": [
        {"type": "node", "id": 1, "lat": 28.6, "lon": 77.2},
        {"type": "node", "id": 2, "lat": 28.6005, "lon": 77.2},
        {"type": "way", "id": 10, "nodes": [1, 2], "tags": {"highway": "footway", "name": "Fixture path"}},
    ]}).encode()


REGION = {"id": "fixture", "name": "Fixture", "subtitle": "Fixture path", "coverageLabel": "Test bounds", "bounds": [77.19, 28.59, 77.21, 28.61]}


def test_manifest_pins_every_asset_and_generation_is_deterministic():
    entry, files = build_pack(REGION, snapshot())
    again, same_files = build_pack(REGION, snapshot())
    assert entry == again and files == same_files
    manifest = json.loads(files["manifest.json"])
    assert entry["manifestSha256"] == hashlib.sha256(files["manifest.json"]).hexdigest()
    assert entry["totalBytes"] == sum(len(files[asset["path"]]) for asset in manifest["assets"])
    assert manifest["profile"] == "walking-v1"
    for asset in manifest["assets"]:
        assert asset["sha256"] == hashlib.sha256(files[asset["path"]]).hexdigest()


def test_source_changes_produce_another_generation():
    a, _ = build_pack(REGION, snapshot())
    b, _ = build_pack(REGION, snapshot().replace(b"Fixture path", b"Changed path"))
    assert a["datasetId"] != b["datasetId"]


def test_incomplete_source_is_rejected_before_publishing():
    source = json.loads(snapshot())
    source["remark"] = "runtime error: timed out"
    with pytest.raises(ValueError, match="incomplete"):
        build_pack(REGION, json.dumps(source).encode())
    source.pop("remark")
    source["elements"].pop(0)
    with pytest.raises(ValueError, match="missing source nodes"):
        build_pack(REGION, json.dumps(source).encode())


def test_explicitly_inaccessible_node_does_not_connect_the_walking_graph():
    source = json.loads(snapshot())
    source["elements"][0]["tags"] = {"barrier": "gate", "foot": "no"}
    with pytest.raises(ValueError, match="no walking graph"):
        build_pack(REGION, json.dumps(source).encode())
