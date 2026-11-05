"""Reject malformed coordinates and precision before entering encoding loops."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import geohash  # noqa: E402


@pytest.mark.parametrize("precision", [0, -1, 1.5, 13, float("inf"), True])
def test_invalid_precision(precision: int) -> None:
    with pytest.raises(ValueError, match="precision"):
        geohash.encode(28.6, 77.2, precision)


@pytest.mark.parametrize("lat, lon", [(float("nan"), 0), (0, float("inf")), (91, 0), (0, -181)])
def test_invalid_coordinates(lat: float, lon: float) -> None:
    with pytest.raises(ValueError, match="coordinates"):
        geohash.encode(lat, lon)


@pytest.mark.parametrize("value", ["", "z" * 13])
def test_invalid_hash_length(value: str) -> None:
    with pytest.raises(ValueError, match="length"):
        geohash.bounds(value)
