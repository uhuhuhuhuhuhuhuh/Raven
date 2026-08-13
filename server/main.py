from __future__ import annotations

import hashlib
import json
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
CACHE_TTL = int(os.getenv("RAVEN_CACHE_TTL", "300"))

app = FastAPI(title="Raven Local API", version="0.1.0")
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
        "name": tags.get("name") or tags.get("ref") or tags.get("operator") or "Mapped camera",
        "lat": element["lat"],
        "lon": element["lon"],
        "address": address,
        "bearing": parse_bearing(tags.get("direction")),
        "operator": tags.get("operator"),
        "zone": tags.get("surveillance:zone"),
        "sourceUrl": f"https://www.openstreetmap.org/{element_type}/{element_id}",
        "attribution": "© OpenStreetMap contributors",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "metadata": tags,
    }


def cache_key(lat: float, lon: float, radius: int) -> str:
    raw = f"osm:{lat:.4f}:{lon:.4f}:{radius}"
    return hashlib.sha256(raw.encode()).hexdigest()


def read_cache(key: str) -> list[dict[str, Any]] | None:
    with db() as connection:
        row = connection.execute("SELECT payload, created_at FROM cache WHERE cache_key = ?", (key,)).fetchone()
    if not row or int(time.time()) - row[1] > CACHE_TTL:
        return None
    return json.loads(row[0])


def write_cache(key: str, features: list[dict[str, Any]]) -> None:
    with db() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO cache(cache_key, payload, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(features), int(time.time())),
        )
        connection.commit()


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "service": "raven",
        "mode": "local",
        "version": "0.1.0",
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
                "capabilities": ["camera-map", "direction", "operator", "camera-type"],
                "enabled": True,
                "mode": "local",
            }
        ]
    }


@app.get("/api/scan")
async def scan(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    radius: int = Query(default=1800, ge=100, le=20000),
) -> dict[str, Any]:
    key = cache_key(lat, lon, radius)
    cached = read_cache(key)
    if cached is not None:
        return {"origin": {"lat": lat, "lon": lon}, "radius": radius, "features": cached, "cached": True}

    query = (
        f'[out:json][timeout:25];('
        f'node["man_made"="surveillance"](around:{radius},{lat},{lon});'
        f'node["highway"="speed_camera"](around:{radius},{lat},{lon});'
        f');out body;'
    )
    try:
        async with httpx.AsyncClient(timeout=35.0, headers={"User-Agent": "Raven/0.1 open-data dashboard"}) as client:
            response = await client.post(OVERPASS_URL, data={"data": query})
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Overpass provider failed: {exc}") from exc

    features = [item for element in payload.get("elements", []) if (item := normalize(element)) is not None]
    write_cache(key, features)
    return {"origin": {"lat": lat, "lon": lon}, "radius": radius, "features": features, "cached": False}


@app.get("/api/stats")
def stats() -> dict[str, Any]:
    with db() as connection:
        cache_rows = connection.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
    return {"cacheEntries": cache_rows, "cacheTtlSeconds": CACHE_TTL}


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
            "message": "Frontend is not built. Run npm install && npm run build in frontend/ or use scripts/run-local.*",
        }
