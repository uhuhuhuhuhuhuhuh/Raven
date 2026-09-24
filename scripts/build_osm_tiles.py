"""Builds Raven's static OpenStreetMap camera tiles from an .osm.pbf extract.

Geofabrik (https://download.geofabrik.de/) publishes daily OSM extracts for every
country and US state, each with a .poly boundary. This script keeps the surveillance
and speed-camera nodes from such an extract and writes them as small JSON tiles plus
an index. GitHub Pages (or Raven Local) serves them as static files; the WebUI reads
them instead of querying the shared public Overpass service whenever a scan lies
entirely inside the extract's boundary, and uses Overpass everywhere else.

    pip install -r scripts/requirements-osm.txt
    python scripts/build_osm_tiles.py --pbf florida-latest.osm.pbf --poly florida.poly \\
        --source "Geofabrik north-america/us/florida" --out frontend/public/api/v1/osm

The input may be a full extract or one already reduced with
`osmium tags-filter ... n/man_made=surveillance n/highway=speed_camera` (as CI does).

With --previous pointing at the last build's output, it also writes changes.json (the
cameras added to or removed from OpenStreetMap since then) and, given --site-url, an
Atom feed of the newly mapped cameras. OSM changes record mapping activity: a newly
mapped camera may have been installed long ago.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

FORMAT_VERSION = 1
TILE_SIZE = 0.5  # degrees; must match frontend/src/providers/osmTiles.ts
CAMERA_TAGS = (("man_made", "surveillance"), ("highway", "speed_camera"))
LICENSE = "Open Database License (ODbL) 1.0 - © OpenStreetMap contributors"
FEED_LIMIT = 500

Camera = tuple[int, float, float, dict[str, str]]


@dataclass(frozen=True)
class Ring:
    points: tuple[tuple[float, float], ...]  # (lon, lat)
    hole: bool = False


def parse_poly(text: str) -> list[Ring]:
    """Parses the Osmosis .poly format Geofabrik publishes: a name line, then sections of
    "lon lat" lines each closed by END (a section named "!..." is a hole), then END."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 2 or lines[-1] != "END":
        raise ValueError("Not a .poly file: expected a name line and a final END")
    rings: list[Ring] = []
    index = 1  # line 0 is the polygon name
    while index < len(lines) - 1:
        hole = lines[index].startswith("!")
        index += 1
        points: list[tuple[float, float]] = []
        while lines[index] != "END":
            lon, lat = (float(value) for value in lines[index].split()[:2])
            points.append((lon, lat))
            index += 1
        index += 1
        if len(points) < 3:
            raise ValueError("A .poly ring needs at least three points")
        rings.append(Ring(tuple(points), hole))
    if not any(not ring.hole for ring in rings):
        raise ValueError("A .poly file needs at least one outer ring")
    return rings


def box_rings(west: float, south: float, east: float, north: float) -> list[Ring]:
    return [Ring(((west, south), (east, south), (east, north), (west, north)))]


def tile_key(lat: float, lon: float) -> str:
    return f"{math.floor(lat / TILE_SIZE)}_{math.floor(lon / TILE_SIZE)}"


def _require_osmium() -> Any:
    try:
        import osmium
    except ImportError as exc:  # pragma: no cover - only without the optional dependency
        raise SystemExit("This script needs pyosmium: pip install -r scripts/requirements-osm.txt") from exc
    return osmium


def read_cameras(pbf: Path) -> tuple[list[Camera], str | None, tuple[float, float, float, float] | None]:
    """Camera nodes plus the extract's replication timestamp and header bounding box."""
    osmium = _require_osmium()
    reader = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING)
    header = reader.header()
    reader.close()
    box = header.box()
    bounds = (box.bottom_left.lon, box.bottom_left.lat, box.top_right.lon, box.top_right.lat) if box.valid() else None

    cameras = []
    for node in osmium.FileProcessor(str(pbf), osmium.osm.NODE).with_filter(osmium.filter.TagFilter(*CAMERA_TAGS)):
        if node.location.valid():
            cameras.append((node.id, round(node.location.lat, 7), round(node.location.lon, 7), {tag.k: tag.v for tag in node.tags}))
    return cameras, header.get("osmosis_replication_timestamp") or None, bounds


def build_tiles(
    cameras: list[Camera],
    rings: list[Ring],
    source: str,
    data_timestamp: str | None,
    out: Path,
) -> dict[str, Any]:
    """Writes tiles/<latIndex>_<lonIndex>.json and index.json into `out` (replacing it)."""
    tiles: dict[str, list[list[Any]]] = defaultdict(list)
    for node_id, lat, lon, tags in sorted(cameras):
        tiles[tile_key(lat, lon)].append([node_id, lat, lon, tags])

    if out.exists():
        shutil.rmtree(out)
    (out / "tiles").mkdir(parents=True)
    for key, records in tiles.items():
        (out / "tiles" / f"{key}.json").write_text(json.dumps(records, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    index = {
        "version": FORMAT_VERSION,
        "source": source,
        "license": LICENSE,
        "dataTimestamp": data_timestamp,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tileSize": TILE_SIZE,
        "count": len(cameras),
        "tiles": sorted(tiles),
        "changes": "changes.json",
        # Coordinates rounded to ~10 m keep a detailed national boundary small.
        "coverage": [{"hole": ring.hole, "points": [[round(lon, 4), round(lat, 4)] for lon, lat in ring.points]} for ring in rings],
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return index


def load_previous(previous: Path | None) -> tuple[dict[int, list[Any]], str | None] | None:
    """Camera records from an earlier build's output, keyed by node id; None when absent or unreadable."""
    if previous is None or not (previous / "index.json").exists():
        return None
    try:
        index = json.loads((previous / "index.json").read_text(encoding="utf-8"))
        records: dict[int, list[Any]] = {}
        for key in index["tiles"]:
            for record in json.loads((previous / "tiles" / f"{key}.json").read_text(encoding="utf-8")):
                records[int(record[0])] = record
        return records, index.get("dataTimestamp")
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return None


def camera_kind(tags: dict[str, str]) -> str:
    if tags.get("surveillance:type", "").lower() == "alpr":
        return "plate reader (ALPR)"
    if tags.get("highway") == "speed_camera":
        return "speed camera"
    return "surveillance camera"


def write_changes(
    out: Path,
    cameras: list[Camera],
    previous: tuple[dict[int, list[Any]], str | None] | None,
    data_timestamp: str | None,
    site_url: str | None = None,
) -> dict[str, Any]:
    """changes.json: cameras added to / removed from OSM since the previous build."""
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    current = {node_id: [node_id, lat, lon, tags] for node_id, lat, lon, tags in cameras}
    if previous is None:
        changes: dict[str, Any] = {"version": FORMAT_VERSION, "baseline": True, "since": None, "until": data_timestamp,
                                   "generatedAt": generated_at, "addedCount": 0, "removedCount": 0, "added": [], "removed": []}
    else:
        before, since = previous
        added = [current[node_id] for node_id in sorted(current.keys() - before.keys())]
        removed = [before[node_id] for node_id in sorted(before.keys() - current.keys())]
        changes = {"version": FORMAT_VERSION, "baseline": False, "since": since, "until": data_timestamp, "generatedAt": generated_at,
                   "addedCount": len(added), "removedCount": len(removed), "added": added, "removed": removed}
    if site_url:
        changes["feed"] = "changes.atom"
        (out / "changes.atom").write_bytes(atom_feed(changes, site_url.rstrip("/") + "/"))
    (out / "changes.json").write_text(json.dumps(changes, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return changes


def atom_feed(changes: dict[str, Any], site_url: str) -> bytes:
    """Atom feed with one entry per newly mapped camera (newest node ids first)."""
    ns = "http://www.w3.org/2005/Atom"
    ElementTree.register_namespace("", ns)
    updated = changes["until"] or changes["generatedAt"]

    def child(parent: ElementTree.Element, tag: str, text: str | None = None, **attributes: str) -> ElementTree.Element:
        element = ElementTree.SubElement(parent, f"{{{ns}}}{tag}", attributes)
        if text is not None:
            element.text = text
        return element

    feed = ElementTree.Element(f"{{{ns}}}feed")
    child(feed, "title", "Raven: cameras newly mapped in OpenStreetMap")
    child(feed, "subtitle", "Weekly changes in surveillance and speed-camera nodes. © OpenStreetMap contributors (ODbL).")
    child(feed, "id", f"{site_url}api/v1/osm/changes.atom")
    child(feed, "link", href=f"{site_url}api/v1/osm/changes.atom", rel="self")
    child(feed, "updated", updated)
    author = child(feed, "author")
    child(author, "name", "Raven")
    for node_id, lat, lon, tags in sorted(changes["added"], key=lambda record: -record[0])[:FEED_LIMIT]:
        entry = child(feed, "entry")
        label = tags.get("name") or tags.get("operator") or tags.get("manufacturer")
        child(entry, "title", f"Newly mapped {camera_kind(tags)}" + (f": {label}" if label else ""))
        child(entry, "id", f"https://www.openstreetmap.org/node/{node_id}")
        child(entry, "link", href=f"{site_url}#map=18.00/{lat:.5f}/{lon:.5f}")
        child(entry, "updated", updated)
        details = "; ".join(f"{key}={value}" for key, value in sorted(tags.items()))
        child(entry, "summary", f"OSM node {node_id} at {lat:.5f}, {lon:.5f}. {details}")
    return ElementTree.tostring(feed, encoding="utf-8", xml_declaration=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--pbf", type=Path, required=True, help="OpenStreetMap .osm.pbf extract")
    parser.add_argument("--poly", type=Path, help="Coverage boundary (.poly); defaults to the file header's bounding box")
    parser.add_argument("--source", help="Label recorded in index.json, e.g. 'Geofabrik north-america/us'")
    parser.add_argument("--out", type=Path, required=True, help="Output directory, e.g. frontend/dist/api/v1/osm")
    parser.add_argument("--previous", type=Path, help="Previous build's output directory, for changes.json")
    parser.add_argument("--site-url", help="Public site URL (e.g. https://user.github.io/Raven/) to write changes.atom")
    args = parser.parse_args(argv)

    cameras, data_timestamp, header_box = read_cameras(args.pbf)
    if args.poly:
        rings = parse_poly(args.poly.read_text(encoding="utf-8"))
    elif header_box:
        rings = box_rings(*header_box)
    else:
        parser.error(f"{args.pbf.name} has no header bounding box; pass its --poly boundary")
    previous = load_previous(args.previous)  # read before --out is replaced, in case they are the same directory
    index = build_tiles(cameras, rings, args.source or args.pbf.name, data_timestamp, args.out)
    changes = write_changes(args.out, cameras, previous, data_timestamp, args.site_url)
    print(f"{index['count']} cameras in {len(index['tiles'])} tiles (data as of {data_timestamp or 'unknown'}) -> {args.out}")
    print("No previous build: changes.json is a baseline." if changes["baseline"]
          else f"Since {changes['since']}: {changes['addedCount']} newly mapped, {changes['removedCount']} removed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
