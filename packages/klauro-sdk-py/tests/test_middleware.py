import asyncio

from klauro_telemetry import KlauroClient
from klauro_telemetry.middleware import (
    KlauroASGIMiddleware,
    KlauroDjangoMiddleware,
)


class RecordingTransport:
    def __init__(self):
        self.batches = []

    def send(self, events):
        self.batches.append(list(events))

        return len(events)

def collector():
    t = RecordingTransport()
    c = KlauroClient(project_id="p", flush_interval=0, transport=t)
    return t, c


def all_events(t):
    return [e for batch in t.batches for e in batch]


def test_asgi_middleware_records_request():
    t, c = collector()

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = KlauroASGIMiddleware(app, client=c)
    scope = {"type": "http", "method": "GET", "path": "/items/42"}
    sent = []

    async def send(msg):
        sent.append(msg)

    async def receive():
        return {"type": "http.request"}

    asyncio.run(mw(scope, receive, send))
    c.flush()

    events = all_events(t)
    assert len(events) == 1
    assert events[0]["type"] == "request"
    assert events[0]["method"] == "GET"
    assert events[0]["path"] == "/items/42"
    assert events[0]["status_code"] == 200
    assert isinstance(events[0]["duration_ms"], float)


def test_asgi_middleware_captures_exception():
    t, c = collector()

    async def app(scope, receive, send):
        raise RuntimeError("handler blew up")

    mw = KlauroASGIMiddleware(app, client=c)
    scope = {"type": "http", "method": "POST", "path": "/x"}

    async def send(msg):
        pass

    async def receive():
        return {"type": "http.request"}

    try:
        asyncio.run(mw(scope, receive, send))
    except RuntimeError:
        pass
    c.flush()

    events = all_events(t)
    assert any(e.get("error_message") == "handler blew up" for e in events)
    # 500 request event also emitted from the finally block.
    assert any(e["type"] == "error" and e.get("status_code") == 500 for e in events)


def test_asgi_middleware_passes_through_non_http():
    t, c = collector()
    called = {"n": 0}

    async def app(scope, receive, send):
        called["n"] += 1

    mw = KlauroASGIMiddleware(app, client=c)
    asyncio.run(mw({"type": "lifespan"}, None, None))
    assert called["n"] == 1
    assert all_events(t) == []


def test_django_middleware_records_request():
    t, c = collector()
    import klauro_telemetry as klauro

    klauro._singleton = c  # Django middleware reads the global client
    try:

        class Response:
            status_code = 201

        class Request:
            method = "POST"
            path = "/orders"
            resolver_match = type("M", (), {"route": "orders/", "view_name": "orders"})()

        mw = KlauroDjangoMiddleware(lambda req: Response())
        mw(Request())
        c.flush()

        events = all_events(t)
        assert len(events) == 1
        assert events[0]["method"] == "POST"
        assert events[0]["route"] == "orders/"
        assert events[0]["status_code"] == 201
    finally:
        klauro._singleton = None
