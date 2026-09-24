from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from server import main


class Upstream:
    """Scripted stand-in for Overpass/Nominatim that records every outbound request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.responses: list[httpx.Response] = []

    def queue(self, *responses: httpx.Response) -> None:
        self.responses.extend(responses)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError(f"unexpected upstream request: {request.method} {request.url}")
        return self.responses.pop(0)


def overpass(*elements: dict) -> httpx.Response:
    return httpx.Response(200, json={"elements": list(elements)})


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Upstream:
    fake = Upstream()
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "raven.db")
    monkeypatch.setattr(main, "HTTP_TRANSPORT", httpx.MockTransport(fake.handle))
    monkeypatch.setattr(main, "nominatim_throttle", main.Throttle(0))
    return fake


@pytest.fixture
def client(upstream: Upstream) -> TestClient:
    return TestClient(main.app)


MIAMI = "west=-80.3&south=25.7&east=-80.1&north=25.9"


def test_health_and_provider_inventory(client: TestClient) -> None:
    health = client.get("/api/health").json()
    assert health["service"] == "raven"
    assert health["mode"] == "local"
    ids = {item["id"] for item in client.get("/api/providers").json()["providers"]}
    assert {"osm-overpass", "fl511-public-cameras", "caltrans-cctv"} <= ids


@pytest.mark.parametrize(
    "query",
    [
        "west=-80.1&south=25.7&east=-80.3&north=25.9",  # west >= east
        "west=-80.3&south=25.9&east=-80.1&north=25.7",  # south >= north
        "",  # neither bounds nor legacy parameters
        "west=-180&south=-80&east=180&north=80",  # whole-world request
    ],
)
def test_scan_rejects_invalid_or_world_scale_bounds_without_calling_overpass(
    client: TestClient, upstream: Upstream, query: str
) -> None:
    assert client.get(f"/api/scan?{query}").status_code == 422
    assert upstream.requests == []


def test_scan_still_accepts_the_largest_legacy_radius(client: TestClient, upstream: Upstream) -> None:
    upstream.queue(overpass())
    response = client.get("/api/scan?lat=0&lon=0&radius=250000")
    assert response.status_code == 200
    assert len(upstream.requests) == 1


def test_scan_normalizes_osm_elements(client: TestClient, upstream: Upstream) -> None:
    upstream.queue(
        overpass(
            {
                "type": "node",
                "id": 1,
                "lat": 25.76,
                "lon": -80.19,
                "tags": {
                    "man_made": "surveillance",
                    "camera:direction": "SW",
                    "direction": "10",
                    "camera:type": "dome",
                    "addr:housenumber": "1",
                    "addr:street": "Main St",
                },
            },
            {"type": "node", "id": 2, "lat": 25.77, "lon": -80.18, "tags": {"highway": "speed_camera", "direction": "90°"}},
            {"type": "way", "id": 3, "tags": {"man_made": "surveillance"}},  # no coordinates: dropped
        )
    )
    payload = client.get(f"/api/scan?{MIAMI}").json()
    features = {feature["sourceId"]: feature for feature in payload["features"]}
    assert set(features) == {"1", "2"}
    assert features["1"]["bearing"] == 225
    assert features["1"]["directionLabel"] == "SW"
    assert features["1"]["cameraType"] == "dome"
    assert features["1"]["address"] == "1 Main St"
    assert features["2"]["cameraType"] == "speed"
    assert features["2"]["bearing"] == 90
    query = dict(httpx.QueryParams(upstream.requests[0].content.decode()))["data"]
    assert "(25.7,-80.3,25.9,-80.1)" in query


def test_scan_serves_repeat_requests_from_cache(client: TestClient, upstream: Upstream) -> None:
    upstream.queue(overpass())
    assert client.get(f"/api/scan?{MIAMI}").json()["cached"] is False
    assert client.get(f"/api/scan?{MIAMI}").json()["cached"] is True
    assert len(upstream.requests) == 1


def test_scan_retries_when_overpass_rate_limits(client: TestClient, upstream: Upstream) -> None:
    upstream.queue(httpx.Response(429, headers={"Retry-After": "0"}), overpass())
    assert client.get(f"/api/scan?{MIAMI}").status_code == 200
    assert len(upstream.requests) == 2


def test_scan_reports_bad_gateway_after_the_retry_budget(client: TestClient, upstream: Upstream) -> None:
    upstream.queue(*[httpx.Response(503, headers={"Retry-After": "0"}) for _ in range(main.UPSTREAM_RETRIES + 1)])
    response = client.get(f"/api/scan?{MIAMI}")
    assert response.status_code == 502
    assert len(upstream.requests) == main.UPSTREAM_RETRIES + 1


def test_search_returns_and_caches_first_result(client: TestClient, upstream: Upstream) -> None:
    upstream.queue(httpx.Response(200, json=[{"lat": "25.7617", "lon": "-80.1918", "display_name": "Miami, Florida"}]))
    first = client.get("/api/search", params={"q": "  Miami   FL "}).json()
    assert first == {"result": {"lat": 25.7617, "lon": -80.1918, "label": "Miami, Florida"}, "cached": False}
    assert client.get("/api/search", params={"q": "miami fl"}).json()["cached"] is True
    assert len(upstream.requests) == 1
    assert upstream.requests[0].headers["User-Agent"].startswith("Raven/")


def test_search_with_no_match_returns_null(client: TestClient, upstream: Upstream) -> None:
    upstream.queue(httpx.Response(200, json=[]))
    assert client.get("/api/search", params={"q": "nowhere"}).json() == {"result": None, "cached": False}


def test_write_cache_prunes_rows_older_than_every_ttl(upstream: Upstream) -> None:
    ancient = int(time.time()) - max(main.CACHE_TTL, main.SEARCH_CACHE_TTL) - 60
    with main.db() as connection:
        connection.execute("INSERT INTO cache VALUES (?, ?, ?)", ("ancient", json.dumps(1), ancient))
    main.write_cache("fresh", {"ok": True})
    with main.db() as connection:
        keys = {row[0] for row in connection.execute("SELECT cache_key FROM cache")}
    assert keys == {"fresh"}


def test_requests_close_every_database_connection(
    client: TestClient, upstream: Upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[sqlite3.Connection] = []
    real_connect: Callable[..., sqlite3.Connection] = sqlite3.connect

    def tracking_connect(*args, **kwargs) -> sqlite3.Connection:
        # Endpoints run on worker threads; allow probing from the test thread so the
        # only error left to observe is "closed database".
        connection = real_connect(*args, check_same_thread=False, **kwargs)
        opened.append(connection)
        return connection

    monkeypatch.setattr(main.sqlite3, "connect", tracking_connect)
    upstream.queue(overpass())
    client.get(f"/api/scan?{MIAMI}")
    client.get("/api/stats")
    assert opened
    for connection in opened:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            connection.execute("SELECT 1")


def test_throttle_spaces_consecutive_calls() -> None:
    throttle = main.Throttle(0.15)

    async def three_calls() -> float:
        start = time.monotonic()
        for _ in range(3):
            await throttle.wait()
        return time.monotonic() - start

    assert asyncio.run(three_calls()) >= 0.3


@pytest.mark.parametrize(
    ("header", "attempt", "expected"),
    [("3", 0, 3.0), (None, 0, 2.0), (None, 2, 8.0), ("nan", 1, 4.0), ("-5", 0, 2.0), ("600", 0, 30.0)],
)
def test_retry_delay_honours_retry_after_with_bounds(header: str | None, attempt: int, expected: float) -> None:
    headers = {"Retry-After": header} if header is not None else {}
    assert main.retry_delay(httpx.Response(503, headers=headers), attempt) == expected


def test_serves_the_static_camera_api_alongside_the_webui(tmp_path) -> None:
    dist = tmp_path / "dist"
    (dist / "api" / "v1").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Raven</title>")
    (dist / "api" / "v1" / "streams.json").write_text(json.dumps({"version": 1, "count": 0, "streams": []}))
    site = main.FastAPI()
    main.mount_frontend(site, dist)
    client = TestClient(site)
    assert client.get("/api/v1/streams.json").json() == {"version": 1, "count": 0, "streams": []}
    assert client.get("/api/v1/missing.json").status_code == 404
    assert "Raven" in client.get("/").text


def test_reports_when_the_webui_is_not_built(tmp_path) -> None:
    site = main.FastAPI()
    main.mount_frontend(site, tmp_path / "missing")
    assert "not built" in TestClient(site).get("/").json()["message"]
