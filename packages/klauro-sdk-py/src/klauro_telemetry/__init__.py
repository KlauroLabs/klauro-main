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

_singleton = None

def init(**kwargs) -> "KlauroClient":
    global _singleton
    if _singleton is not None:
        _singleton.shutdown()
    _singleton = KlauroClient(**kwargs)
    return _singleton

def get_client():
    return _singleton

def record_event(event) -> None:
    if _singleton is not None:
        _singleton.record_event(event)

def record(name, attributes=None) -> None:
    if _singleton is not None:
        _singleton.record(name, attributes)

def increment_counter(name, value=1, attributes=None) -> None:
    if _singleton is not None:
        _singleton.increment_counter(name, value, attributes)

def record_gauge(name, value, attributes=None) -> None:
    if _singleton is not None:
        _singleton.record_gauge(name, value, attributes)

def capture_error(err, extra=None) -> None:
    if _singleton is not None:
        _singleton.capture_error(err, extra)

def start_span(name, extra=None) -> "Span":
    if _singleton is not None:
        return _singleton.start_span(name, extra)
    return Span._noop()

def flush() -> None:
    if _singleton is not None:
        _singleton.flush()

def shutdown() -> None:
    global _singleton
    if _singleton is not None:
        _singleton.shutdown()
        _singleton = None
