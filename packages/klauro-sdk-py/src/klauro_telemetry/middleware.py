"""Framework integrations: FastAPI (ASGI), Flask, Django.

Each integration is duck-typed and imports nothing from the framework at module
load, so ``klauro-telemetry`` installs cleanly in any project. Install the
matching extra (``klauro-telemetry[fastapi]`` etc.) for your framework.
"""

import time

from . import get_client


def _elapsed_ms(started_at):
    """Elapsed milliseconds from a ``time.perf_counter()`` reading.

    ``perf_counter`` is a monotonic high-resolution clock, so latency is
    accurate even for sub-millisecond handlers and immune to wall-clock jumps.
    Rounded to 3 decimals so fast handlers still produce a comparable value.
    """
    return round(max(0.0, (time.perf_counter() - started_at) * 1000.0), 3)


def _route_of_asgi(scope):
    # Starlette/FastAPI put the matched route object under scope["route"].
    route = scope.get("route")
    if route is not None:
        return getattr(route, "path", None) or getattr(route, "path_format", None)
    return scope.get("path")


class KlauroASGIMiddleware:
    """ASGI middleware for FastAPI / Starlette.

        from klauro_telemetry.middleware import KlauroASGIMiddleware
        app.add_middleware(KlauroASGIMiddleware)
    """

    def __init__(self, app, client=None):
        self.app = app
        self._client = client

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        client = self._client or get_client()
        if client is None:
            await self.app(scope, receive, send)
            return

        started_at = time.perf_counter()
        status_holder = {"status": 500}

        async def send_wrapper(message):
            if message.get("type") == "http.response.start":
                status_holder["status"] = message.get("status", 200)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:  # noqa: BLE001
            client.capture_error(
                exc,
                {
                    "method": scope.get("method"),
                    "route": _route_of_asgi(scope),
                    "path": scope.get("path"),
                    "duration_ms": _elapsed_ms(started_at),
                },
            )
            raise
        finally:
            status = status_holder["status"]
            client.record_event(
                {
                    "type": "error" if status >= 500 else "request",
                    "method": scope.get("method"),
                    "route": _route_of_asgi(scope),
                    "path": scope.get("path"),
                    "status_code": status,
                    "duration_ms": _elapsed_ms(started_at),
                }
            )


def init_flask(app, client=None):
    """Instrument a Flask app via before/after/teardown request hooks.

        from klauro_telemetry.middleware import init_flask
        init_flask(app)
    """
    from flask import g, request  # local import; requires the flask extra

    @app.before_request
    def _klauro_before():
        g._klauro_started_at = time.perf_counter()

    @app.after_request
    def _klauro_after(response):
        c = client or get_client()
        if c is not None:
            started = getattr(g, "_klauro_started_at", time.perf_counter())
            status = response.status_code
            c.record_event(
                {
                    "type": "error" if status >= 500 else "request",
                    "method": request.method,
                    "route": str(request.url_rule) if request.url_rule else None,
                    "path": request.path,
                    "status_code": status,
                    "duration_ms": _elapsed_ms(started),
                }
            )
        return response

    @app.teardown_request
    def _klauro_teardown(exc):
        c = client or get_client()
        if c is not None and exc is not None:
            c.capture_error(
                exc, {"method": request.method, "route": str(request.url_rule) if request.url_rule else None, "path": request.path}
            )

    return app


class KlauroDjangoMiddleware:
    """Django middleware. Add to ``MIDDLEWARE`` in settings:

        MIDDLEWARE = [..., "klauro_telemetry.middleware.KlauroDjangoMiddleware"]
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        client = get_client()
        started_at = time.perf_counter()
        response = self.get_response(request)
        if client is not None:
            status = getattr(response, "status_code", 200)
            client.record_event(
                {
                    "type": "error" if status >= 500 else "request",
                    "method": request.method,
                    "route": self._route_of(request),
                    "path": request.path,
                    "status_code": status,
                    "duration_ms": _elapsed_ms(started_at),
                }
            )
        return response

    def process_exception(self, request, exception):
        client = get_client()
        if client is not None:
            client.capture_error(
                exception, {"method": request.method, "route": self._route_of(request), "path": request.path}
            )
        return None

    @staticmethod
    def _route_of(request):
        match = getattr(request, "resolver_match", None)
        if match is not None:
            return getattr(match, "route", None) or getattr(match, "view_name", None)
        return None
