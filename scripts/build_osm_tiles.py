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

FORMAT_VERSION = 1
TILE_SIZE = 0.5  # degrees; must match frontend/src/providers/osmTiles.ts
CAMERA_TAGS = (("man_made", "surveillance"), ("highway", "speed_camera"))
LICENSE = "Open Database License (ODbL) 1.0 - © OpenStreetMap contributors"


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


def read_cameras(pbf: Path) -> tuple[list[tuple[int, float, float, dict[str, str]]], str | None, tuple[float, float, float, float] | None]:
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
    cameras: list[tuple[int, float, float, dict[str, str]]],
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
        # Coordinates rounded to ~10 m keep a detailed national boundary small.
        "coverage": [{"hole": ring.hole, "points": [[round(lon, 4), round(lat, 4)] for lon, lat in ring.points]} for ring in rings],
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--pbf", type=Path, required=True, help="OpenStreetMap .osm.pbf extract")
    parser.add_argument("--poly", type=Path, help="Coverage boundary (.poly); defaults to the file header's bounding box")
    parser.add_argument("--source", help="Label recorded in index.json, e.g. 'Geofabrik north-america/us'")
    parser.add_argument("--out", type=Path, required=True, help="Output directory, e.g. frontend/dist/api/v1/osm")
    args = parser.parse_args(argv)

    cameras, data_timestamp, header_box = read_cameras(args.pbf)
    if args.poly:
        rings = parse_poly(args.poly.read_text(encoding="utf-8"))
    elif header_box:
        rings = box_rings(*header_box)
    else:
        parser.error(f"{args.pbf.name} has no header bounding box; pass its --poly boundary")
    index = build_tiles(cameras, rings, args.source or args.pbf.name, data_timestamp, args.out)
    print(f"{index['count']} cameras in {len(index['tiles'])} tiles (data as of {data_timestamp or 'unknown'}) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
