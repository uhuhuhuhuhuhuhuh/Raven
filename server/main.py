from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("RAVEN_DB", ROOT / "server" / "data" / "raven.db"))
FRONTEND_DIST = ROOT / "frontend" / "dist"
OVERPASS_URL = os.getenv("RAVEN_OVERPASS_URL", "https://overpass-api.de/api/interpreter")
NOMINATIM_URL = os.getenv("RAVEN_NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")
CACHE_TTL = int(os.getenv("RAVEN_CACHE_TTL", "300"))
SEARCH_CACHE_TTL = int(os.getenv("RAVEN_SEARCH_CACHE_TTL", "86400"))
USER_AGENT = "Raven/1.1 (+https://github.com/uhuhuhuhuhuhuhuh/Raven)"

app = FastAPI(title="Raven Local API", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS cache (
            cache_key TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def read_cache(key: str, ttl: int) -> Any | None:
    with db() as connection:
        row = connection.execute("SELECT payload, created_at FROM cache WHERE cache_key = ?", (key,)).fetchone()
    if not row or int(time.time()) - int(row[1]) > ttl:
        return None
    return json.loads(row[0])


def write_cache(key: str, payload: Any) -> None:
    with db() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO cache(cache_key, payload, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(payload), int(time.time())),
        )
        connection.commit()


def stable_key(prefix: str, *parts: Any) -> str:
    raw = ":".join([prefix, *[str(part) for part in parts]])
    return hashlib.sha256(raw.encode()).hexdigest()


def parse_bearing(raw: str | None) -> float | None:
    if not raw:
        return None
    try:
        return float(raw.replace("°", "").strip()) % 360
    except ValueError:
        return None


def camera_type(tags: dict[str, str]) -> str:
    if tags.get("surveillance:type", "").lower() == "alpr":
        return "alpr"
    if tags.get("highway") == "speed_camera":
        return "speed"
    value = tags.get("camera:type", "").lower()
    return {
        "fixed": "fixed",
        "dome": "dome",
        "panning": "ptz",
        "panorama": "panorama",
        "panorama_with_ptz": "panorama",
    }.get(value, "unknown")


def normalize(element: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(element.get("lat"), (int, float)) or not isinstance(element.get("lon"), (int, float)):
        return None
    tags: dict[str, str] = element.get("tags") or {}
    address_parts = [tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:city")]
    address = " ".join(part for part in address_parts if part) or None
    element_type = element.get("type", "node")
    element_id = element.get("id")
    return {
        "id": f"osm-{element_type}-{element_id}",
        "providerId": "osm-overpass",
        "sourceId": str(element_id),
        "kind": "camera",
        "cameraType": camera_type(tags),
        "mediaType": "none",
        "mediaHealth": "unknown",
        "name": tags.get("name") or tags.get("ref") or tags.get("operator") or "Mapped camera",
        "lat": element["lat"],
        "lon": element["lon"],
        "address": address,
        "bearing": parse_bearing(tags.get("direction")),
        "directionLabel": tags.get("direction"),
        "operator": tags.get("operator"),
        "zone": tags.get("surveillance:zone"),
        "sourceUrl": f"https://www.openstreetmap.org/{element_type}/{element_id}",
        "attribution": "© OpenStreetMap contributors",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metadata": tags,
    }


def bounds_from_legacy(lat: float, lon: float, radius: int) -> tuple[float, float, float, float]:
    lat_delta = radius / 111_320
    cos_lat = max(math.cos(math.radians(lat)), 0.2)
    lon_delta = radius / (111_320 * cos_lat)
    return lon - lon_delta, lat - lat_delta, lon + lon_delta, lat + lat_delta


def validate_bounds(west: float, south: float, east: float, north: float) -> tuple[float, float, float, float]:
    if west >= east or south >= north:
        raise HTTPException(status_code=422, detail="Invalid viewport bounds")
    return west, south, east, north


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "service": "raven",
        "mode": "local",
        "version": "1.1.0",
        "database": str(DB_PATH),
        "frontendBuilt": (FRONTEND_DIST / "index.html").exists(),
    }


@app.get("/api/providers")
def providers() -> dict[str, Any]:
    return {
        "providers": [
            {
                "id": "osm-overpass",
                "name": "OpenStreetMap / Overpass",
                "capabilities": ["mapped-camera", "direction", "operator", "camera-type"],
                "enabled": True,
                "execution": "server",
            },
            {
                "id": "fl511-public-cameras",
                "name": "FL511 Traffic Cameras",
                "capabilities": ["snapshot", "direction", "operator"],
                "enabled": True,
                "execution": "browser",
                "coverage": "Florida",
            },
            {
                "id": "caltrans-cctv",
                "name": "Caltrans CCTV",
                "capabilities": ["snapshot", "stream", "direction", "operator"],
                "enabled": True,
                "execution": "browser",
                "coverage": "California",
            },
        ]
    }


@app.get("/api/scan")
async def scan(
    west: float | None = Query(default=None, ge=-180, le=180),
    south: float | None = Query(default=None, ge=-90, le=90),
    east: float | None = Query(default=None, ge=-180, le=180),
    north: float | None = Query(default=None, ge=-90, le=90),
    lat: float | None = Query(default=None, ge=-90, le=90),
    lon: float | None = Query(default=None, ge=-180, le=180),
    radius: int | None = Query(default=None, ge=100, le=250_000),
) -> dict[str, Any]:
    supplied_bounds = all(value is not None for value in (west, south, east, north))
    supplied_legacy = lat is not None and lon is not None and radius is not None
    if supplied_bounds:
        bbox = validate_bounds(float(west), float(south), float(east), float(north))
    elif supplied_legacy:
        bbox = validate_bounds(*bounds_from_legacy(float(lat), float(lon), int(radius)))
    else:
        raise HTTPException(status_code=422, detail="Supply west/south/east/north or legacy lat/lon/radius")

    west_v, south_v, east_v, north_v = bbox
    key = stable_key("osm-bbox", f"{west_v:.5f}", f"{south_v:.5f}", f"{east_v:.5f}", f"{north_v:.5f}")
    cached = read_cache(key, CACHE_TTL)
    if cached is not None:
        return {"bounds": {"west": west_v, "south": south_v, "east": east_v, "north": north_v}, "features": cached, "cached": True}

    bbox_text = f"{south_v},{west_v},{north_v},{east_v}"
    query = (
        f'[out:json][timeout:25];('
        f'node["man_made"="surveillance"]({bbox_text});'
        f'node["highway"="speed_camera"]({bbox_text});'
        f');out body;'
    )
    try:
        async with httpx.AsyncClient(timeout=35.0, headers={"User-Agent": USER_AGENT}) as client:
            response = await client.post(OVERPASS_URL, data={"data": query})
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Overpass provider failed: {exc}") from exc

    features = [item for element in payload.get("elements", []) if (item := normalize(element)) is not None]
    write_cache(key, features)
    return {"bounds": {"west": west_v, "south": south_v, "east": east_v, "north": north_v}, "features": features, "cached": False}


@app.get("/api/search")
async def search(q: str = Query(min_length=1, max_length=300)) -> dict[str, Any]:
    normalized_query = " ".join(q.split())
    key = stable_key("search", normalized_query.lower())
    cached = read_cache(key, SEARCH_CACHE_TTL)
    if cached is not None:
        return {"result": cached, "cached": True}

    params = {"q": normalized_query, "format": "jsonv2", "limit": "1"}
    try:
        async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"}) as client:
            response = await client.get(NOMINATIM_URL, params=params)
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Search provider failed: {exc}") from exc

    result = None
    if payload:
        result = {
            "lat": float(payload[0]["lat"]),
            "lon": float(payload[0]["lon"]),
            "label": str(payload[0].get("display_name") or normalized_query),
        }
    write_cache(key, result)
    return {"result": result, "cached": False}


@app.get("/api/stats")
def stats() -> dict[str, Any]:
    with db() as connection:
        cache_rows = connection.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
    return {"cacheEntries": cache_rows, "cameraCacheTtlSeconds": CACHE_TTL, "searchCacheTtlSeconds": SEARCH_CACHE_TTL}


if FRONTEND_DIST.exists():
    assets = FRONTEND_DIST / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/")
    def frontend_root() -> FileResponse:
        return FileResponse(FRONTEND_DIST / "index.html")
else:
    @app.get("/")
    def frontend_missing() -> dict[str, str]:
        return {
            "service": "raven",
            "message": "Frontend is not built. Run npm ci && npm run build in frontend/ or use scripts/run-local.*",
        }
