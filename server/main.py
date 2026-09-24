from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
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
# Largest bbox forwarded to the shared public Overpass service (~700 km x 700 km).
# Comfortably above any tile the WebUI sends; stops world/continent-scale requests.
MAX_BBOX_AREA_KM2 = float(os.getenv("RAVEN_MAX_BBOX_KM2", "500000"))
# Nominatim's usage policy allows at most one request per second.
NOMINATIM_MIN_INTERVAL = float(os.getenv("RAVEN_NOMINATIM_MIN_INTERVAL", "1.0"))
UPSTREAM_RETRIES = 2
RETRYABLE_STATUS = {429, 502, 503, 504}
USER_AGENT = "Raven/1.1 (+https://github.com/uhuhuhuhuhuhuhuh/Raven)"
# Tests swap in an httpx.MockTransport; None uses the real network.
HTTP_TRANSPORT: httpx.AsyncBaseTransport | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_created_at ON cache(created_at);
"""

app = FastAPI(title="Raven Local API", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """Opens the cache database for one unit of work: commits on success, always closes.

    A bare ``with sqlite3.connect(...)`` only commits; it never closes the connection.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    try:
        connection.executescript(SCHEMA)
        with connection:
            yield connection
    finally:
        connection.close()


def read_cache(key: str, ttl: int) -> Any | None:
    with db() as connection:
        row = connection.execute("SELECT payload, created_at FROM cache WHERE cache_key = ?", (key,)).fetchone()
    if not row or int(time.time()) - int(row[1]) > ttl:
        return None
    return json.loads(row[0])


def write_cache(key: str, payload: Any) -> None:
    now = int(time.time())
    with db() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO cache(cache_key, payload, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(payload), now),
        )
        # Rows older than the longest TTL can never be served again.
        connection.execute("DELETE FROM cache WHERE created_at < ?", (now - max(CACHE_TTL, SEARCH_CACHE_TTL),))


class Throttle:
    """Serialises callers so consecutive calls start at least ``interval`` seconds apart."""

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self._lock = asyncio.Lock()
        self._last = float("-inf")

    async def wait(self) -> None:
        async with self._lock:
            delay = self._last + self.interval - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            self._last = time.monotonic()


nominatim_throttle = Throttle(NOMINATIM_MIN_INTERVAL)


def retry_delay(response: httpx.Response, attempt: int) -> float:
    """Honours a numeric Retry-After, otherwise backs off exponentially; capped at 30 s."""
    try:
        delay = float(response.headers.get("Retry-After", ""))
    except ValueError:
        delay = math.nan
    if not math.isfinite(delay) or delay < 0:
        delay = 2.0 * 2**attempt
    return min(delay, 30.0)


async def request_with_retry(client: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> httpx.Response:
    """Retries a bounded number of times when a shared public service is rate limiting or overloaded."""
    attempt = 0
    while True:
        response = await client.request(method, url, **kwargs)
        if response.status_code not in RETRYABLE_STATUS or attempt >= UPSTREAM_RETRIES:
            return response
        await asyncio.sleep(retry_delay(response, attempt))
        attempt += 1


def stable_key(prefix: str, *parts: Any) -> str:
    raw = ":".join([prefix, *[str(part) for part in parts]])
    return hashlib.sha256(raw.encode()).hexdigest()


COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def parse_bearing(raw: str | None) -> float | None:
    """Degrees ("45", "45°") or a 16-point compass abbreviation ("SW"), normalised into [0, 360)."""
    if not raw:
        return None
    text = raw.replace("°", "").strip()
    try:
        return float(text) % 360
    except ValueError:
        pass
    upper = text.upper()
    return COMPASS_POINTS.index(upper) * 22.5 if upper in COMPASS_POINTS else None


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
    # `camera:direction` is the documented surveillance tag; plain `direction` is the common fallback.
    direction = tags.get("camera:direction") or tags.get("direction")
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
        "bearing": parse_bearing(direction),
        "directionLabel": direction,
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


def bbox_area_km2(west: float, south: float, east: float, north: float) -> float:
    height_km = (north - south) * 111.32
    width_km = (east - west) * 111.32 * math.cos(math.radians((north + south) / 2))
    return abs(width_km * height_km)


def validate_bounds(west: float, south: float, east: float, north: float) -> tuple[float, float, float, float]:
    if west >= east or south >= north:
        raise HTTPException(status_code=422, detail="Invalid viewport bounds")
    if bbox_area_km2(west, south, east, north) > MAX_BBOX_AREA_KM2:
        raise HTTPException(status_code=422, detail="Viewport too large for the public Overpass service; zoom in")
    return west, south, east, north


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "service": "raven",
        "mode": "local",
        "version": "1.1.0",
        "database": str(DB_PATH),
        "frontendBuilt": (FRONTEND_DIST / "index.html").exists(),
        "staticApiBuilt": (FRONTEND_DIST / "api" / "v1" / "index.json").exists(),
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
        async with httpx.AsyncClient(timeout=35.0, headers={"User-Agent": USER_AGENT}, transport=HTTP_TRANSPORT) as client:
            response = await request_with_retry(client, "POST", OVERPASS_URL, data={"data": query})
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
        await nominatim_throttle.wait()
        async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"}, transport=HTTP_TRANSPORT) as client:
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


def mount_frontend(target: FastAPI, dist: Path) -> None:
    """Serves the built WebUI and, once `npm run build:api` has run, the same static
    camera/stream API that GitHub Pages publishes, under /api/v1."""
    if not dist.exists():
        @target.get("/")
        def frontend_missing() -> dict[str, str]:
            return {
                "service": "raven",
                "message": "Frontend is not built. Run npm ci && npm run build in frontend/ or use scripts/run-local.*",
            }

        return

    assets = dist / "assets"
    if assets.exists():
        target.mount("/assets", StaticFiles(directory=assets), name="assets")
    static_api = dist / "api" / "v1"
    if static_api.exists():
        target.mount("/api/v1", StaticFiles(directory=static_api), name="static-api")

    @target.get("/")
    def frontend_root() -> FileResponse:
        return FileResponse(dist / "index.html")


mount_frontend(app, FRONTEND_DIST)
