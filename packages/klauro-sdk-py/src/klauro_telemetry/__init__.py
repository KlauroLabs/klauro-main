"""Klauro runtime telemetry SDK for Python.

Emits CAS-correlated runtime events (requests, errors, spans, counters, gauges)
so production signal maps back onto your Klauro static analysis. The event
schema is kept EXACTLY compatible with the CAS runtime event contract
(``get_runtime_event_contract``); the ingest endpoint correlates on these
identifiers, so field names must not be renamed.

Basic usage::

    from klauro_telemetry import init, record, capture_error, start_span

    init(api_key="...", project_id="my-project", service="items-api", environment="production")
    record("cache.miss", {"key": "user:42"})
"""

from .client import KlauroClient, Span
from .contract import SCHEMA_VERSION, DEFAULT_ENDPOINT, EVENT_TYPES

__all__ = [
    "KlauroClient",
    "Span",
    "SCHEMA_VERSION",
    "DEFAULT_ENDPOINT",
    "EVENT_TYPES",
    "init",
    "get_client",
    "record",
    "record_event",
    "increment_counter",
    "record_gauge",
    "capture_error",
    "start_span",
    "flush",
    "shutdown",
]

_singleton = None  # type: ignore[var-annotated]


def init(**kwargs) -> "KlauroClient":
    """Initialize the global Klauro client.

    Accepts the same keyword args as :class:`KlauroClient`: ``project_id``
    (required), ``api_key``, ``endpoint``, ``service``, ``environment``,
    ``batch_size``, ``flush_interval``, ``max_queue_size``, ``transport``,
    ``on_error``, ``debug``. Returns the client.
    """
    global _singleton
    if _singleton is not None:
        _singleton.shutdown()
    _singleton = KlauroClient(**kwargs)
    return _singleton


def get_client():
    """Return the initialized client, or ``None`` if :func:`init` was not called."""
    return _singleton


def record_event(event) -> None:
    """Record a fully-formed CAS runtime event. No-op if uninitialized."""
    if _singleton is not None:
        _singleton.record_event(event)


def record(name, attributes=None) -> None:
    """Record a named custom event. No-op if uninitialized."""
    if _singleton is not None:
        _singleton.record(name, attributes)


def increment_counter(name, value=1, attributes=None) -> None:
    """Increment a counter. No-op if uninitialized."""
    if _singleton is not None:
        _singleton.increment_counter(name, value, attributes)


def record_gauge(name, value, attributes=None) -> None:
    """Record a gauge reading. No-op if uninitialized."""
    if _singleton is not None:
        _singleton.record_gauge(name, value, attributes)


def capture_error(err, extra=None) -> None:
    """Capture an error. No-op if uninitialized."""
    if _singleton is not None:
        _singleton.capture_error(err, extra)


def start_span(name, extra=None) -> "Span":
    """Start a span. Returns a no-op span if uninitialized."""
    if _singleton is not None:
        return _singleton.start_span(name, extra)
    return Span._noop()


def flush() -> None:
    """Flush the global client. No-op if uninitialized."""
    if _singleton is not None:
        _singleton.flush()


def shutdown() -> None:
    """Flush and stop the global client. No-op if uninitialized."""
    global _singleton
    if _singleton is not None:
        _singleton.shutdown()
        _singleton = None
