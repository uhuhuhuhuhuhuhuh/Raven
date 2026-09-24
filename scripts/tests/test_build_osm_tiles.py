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


def test_changes_list_cameras_added_and_removed_since_the_previous_build(tmp_path: Path) -> None:
    previous_out = tmp_path / "last-week"
    last_week = [(1, 25.76, -80.19, {"man_made": "surveillance"}), (9, 25.70, -80.20, {"man_made": "surveillance"})]
    tiles.build_tiles(last_week, tiles.parse_poly(POLY), "test", "2026-09-15T20:00:00Z", previous_out)

    out = tmp_path / "osm"
    cameras, timestamp, _ = tiles.read_cameras(write_pbf(tmp_path / "fl.osm.pbf"))
    tiles.build_tiles(cameras, tiles.parse_poly(POLY), "test", timestamp, out)
    changes = tiles.write_changes(out, cameras, tiles.load_previous(previous_out), timestamp)

    assert changes["baseline"] is False
    assert (changes["since"], changes["until"]) == ("2026-09-15T20:00:00Z", "2026-09-22T20:21:02Z")
    assert [record[0] for record in changes["added"]] == [2, 4]
    assert [record[0] for record in changes["removed"]] == [9]
    assert (changes["addedCount"], changes["removedCount"]) == (2, 1)
    assert json.loads((out / "changes.json").read_text()) == changes
    assert "feed" not in changes and not (out / "changes.atom").exists()


def test_first_build_writes_a_baseline_and_unreadable_history_is_ignored(tmp_path: Path) -> None:
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "index.json").write_text('{"tiles": ["51_-161"]}')  # tile file missing
    assert tiles.load_previous(broken) is None
    assert tiles.load_previous(tmp_path / "missing") is None
    changes = tiles.write_changes(tmp_path, [(1, 25.76, -80.19, {})], None, "2026-09-22T20:21:02Z")
    assert changes["baseline"] is True
    assert changes["added"] == [] and changes["addedCount"] == 0


def test_atom_feed_links_each_newly_mapped_camera_to_the_map(tmp_path: Path) -> None:
    from xml.etree import ElementTree

    changes = tiles.write_changes(
        tmp_path,
        [(1, 25.76, -80.19, {"man_made": "surveillance"}), (5, 27.95, -82.46, {"man_made": "surveillance", "surveillance:type": "ALPR", "manufacturer": "Flock Safety"})],
        ({1: [1, 25.76, -80.19, {"man_made": "surveillance"}]}, "2026-09-15T20:00:00Z"),
        "2026-09-22T20:21:02Z",
        site_url="https://example.github.io/Raven",
    )
    assert changes["addedCount"] == 1
    assert changes["feed"] == "changes.atom"
    assert json.loads((tmp_path / "changes.json").read_text())["feed"] == "changes.atom"
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    feed = ElementTree.fromstring((tmp_path / "changes.atom").read_bytes())
    entries = feed.findall("atom:entry", ns)
    assert len(entries) == 1
    assert entries[0].findtext("atom:title", namespaces=ns) == "Newly mapped plate reader (ALPR): Flock Safety"
    assert entries[0].findtext("atom:id", namespaces=ns) == "https://www.openstreetmap.org/node/5"
    assert entries[0].find("atom:link", ns).get("href") == "https://example.github.io/Raven/#map=18.00/27.95000/-82.46000"
    assert feed.findtext("atom:updated", namespaces=ns) == "2026-09-22T20:21:02Z"


def test_cli_reads_the_previous_build_even_when_it_is_the_output_directory(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "osm"
    tiles.build_tiles([(9, 25.70, -80.20, {"man_made": "surveillance"})], tiles.parse_poly(POLY), "test", "2026-09-15T20:00:00Z", out)
    pbf = str(write_pbf(tmp_path / "fl.osm.pbf"))
    assert tiles.main(["--pbf", pbf, "--out", str(out), "--previous", str(out), "--site-url", "https://example.github.io/Raven/"]) == 0
    changes = json.loads((out / "changes.json").read_text())
    assert (changes["addedCount"], changes["removedCount"]) == (3, 1)
    assert json.loads((out / "index.json").read_text())["changes"] == "changes.json"
    assert (out / "changes.atom").exists()
    assert "3 newly mapped, 1 removed" in capsys.readouterr().out
