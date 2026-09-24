from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import build_osm_tiles as tiles

osmium = pytest.importorskip("osmium")

POLY = """florida
1
   -8.770000E+01   2.430000E+01
   -7.970000E+01   2.430000E+01
   -7.970000E+01   3.120000E+01
   -8.770000E+01   3.120000E+01
END
!2
   -8.100000E+01   2.600000E+01
   -8.000000E+01   2.600000E+01
   -8.000000E+01   2.700000E+01
END
END
"""


def write_pbf(path: Path, *, box: bool = True) -> Path:
    header = osmium.io.Header()
    header.set("osmosis_replication_timestamp", "2026-09-22T20:21:02Z")
    if box:
        header.add_box(osmium.osm.Box(-87.7, 24.3, -79.7, 31.2))
    writer = osmium.SimpleWriter(str(path), header=header)
    Node = osmium.osm.mutable.Node
    writer.add_node(Node(id=1, location=(-80.19, 25.76), tags={"man_made": "surveillance", "camera:direction": "NE"}))
    writer.add_node(Node(id=2, location=(-80.11, 25.79), tags={"highway": "speed_camera"}))
    writer.add_node(Node(id=3, location=(-80.18, 25.77), tags={"amenity": "cafe"}))
    writer.add_node(Node(id=4, location=(-82.46, 27.95), tags={"man_made": "surveillance", "surveillance:type": "ALPR"}))
    writer.close()
    return path


def test_parse_poly_reads_outer_rings_and_holes() -> None:
    rings = tiles.parse_poly(POLY)
    assert [ring.hole for ring in rings] == [False, True]
    assert rings[0].points[0] == (-87.7, 24.3)
    assert len(rings[1].points) == 3


@pytest.mark.parametrize("text", ["", "name\n1\n 0 0\n 1 1\nEND\nEND\n", "name\n!1\n 0 0\n 1 0\n 1 1\nEND\nEND\n"])
def test_parse_poly_rejects_malformed_boundaries(text: str) -> None:
    with pytest.raises(ValueError):
        tiles.parse_poly(text)


def test_tile_keys_floor_toward_negative_infinity() -> None:
    assert tiles.tile_key(25.76, -80.19) == "51_-161"
    assert tiles.tile_key(-0.1, 0.1) == "-1_0"


def test_builds_camera_tiles_with_coverage_and_data_date(tmp_path: Path) -> None:
    cameras, timestamp, box = tiles.read_cameras(write_pbf(tmp_path / "florida.osm.pbf"))
    assert sorted(camera[0] for camera in cameras) == [1, 2, 4]
    assert timestamp == "2026-09-22T20:21:02Z"
    assert box == pytest.approx((-87.7, 24.3, -79.7, 31.2))

    out = tmp_path / "osm"
    index = tiles.build_tiles(cameras, tiles.parse_poly(POLY), "Geofabrik north-america/us/florida", timestamp, out)
    assert index["count"] == 3
    assert index["tiles"] == ["51_-161", "55_-165"]
    assert index["coverage"][1]["hole"] is True
    assert "ODbL" in index["license"]
    miami = json.loads((out / "tiles" / "51_-161.json").read_text())
    assert miami == [[1, 25.76, -80.19, {"man_made": "surveillance", "camera:direction": "NE"}], [2, 25.79, -80.11, {"highway": "speed_camera"}]]
    assert json.loads((out / "index.json").read_text()) == index


def test_cli_replaces_old_output_and_falls_back_to_the_header_box(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "osm"
    (out / "tiles").mkdir(parents=True)
    (out / "tiles" / "stale.json").write_text("[]")
    assert tiles.main(["--pbf", str(write_pbf(tmp_path / "fl.osm.pbf")), "--out", str(out)]) == 0
    assert not (out / "tiles" / "stale.json").exists()
    index = json.loads((out / "index.json").read_text())
    assert index["source"] == "fl.osm.pbf"
    assert index["coverage"] == [{"hole": False, "points": [[-87.7, 24.3], [-79.7, 24.3], [-79.7, 31.2], [-87.7, 31.2]]}]
    assert "3 cameras in 2 tiles" in capsys.readouterr().out


def test_cli_requires_a_boundary_when_the_extract_has_no_header_box(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        tiles.main(["--pbf", str(write_pbf(tmp_path / "filtered.osm.pbf", box=False)), "--out", str(tmp_path / "osm")])
