"""Klauro telemetry client: batched, non-blocking, crash-safe delivery."""

import atexit
import json
import os
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

from .contract import SCHEMA_VERSION, DEFAULT_ENDPOINT, ingest_path


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _rand_hex(nbytes):
    return os.urandom(nbytes).hex()


class HttpTransport:
    """Default transport: POSTs {"events": [...]} to the CAS ingest endpoint.

    Delivery is best-effort. Failures raise, and the client re-queues + reports.
    """

    def __init__(self, endpoint, project_id, api_key=None, timeout=5.0):
        self.url = endpoint.rstrip("/") + ingest_path(project_id)
        self.api_key = api_key
        self.timeout = timeout

    def send(self, events):
        body = json.dumps({"events": events}).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = "Bearer {}".format(self.api_key)
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            if status < 200 or status >= 300:
                raise RuntimeError("klauro ingest returned HTTP {}".format(status))


class Span:
    """A live span. ``end()`` records an ``exit`` event with the elapsed duration."""

    def __init__(self, client, name, extra=None):
        self._client = client
        self._name = name
        self._extra = dict(extra or {})
        self._attributes = dict(self._extra.pop("attributes", {}) or {})
        self._trace_id = self._extra.get("trace_id") or _rand_hex(16)
        self._span_id = _rand_hex(8)
        self._started_at = time.time()
        self._ended = False

    @property
    def span_id(self):
        return self._span_id

    @property
    def trace_id(self):
        return self._trace_id

    def set_attribute(self, key, value):
        self._attributes[key] = value
        return self

    def end(self, extra=None):
        if self._ended:
            return
        self._ended = True
        if self._client is None:
            return
        end_extra = dict(extra or {})
        attrs = dict(self._attributes)
        attrs.update(end_extra.pop("attributes", {}) or {})
        event = {
            "type": "exit",
            "signal": self._name,
            "trace_id": self._trace_id,
            "span_id": self._span_id,
            "duration_ms": (time.time() - self._started_at) * 1000.0,
        }
        event.update(self._extra)
        event.update(end_extra)
        event["attributes"] = attrs
        self._client.record_event(event)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is not None and self._client is not None:
            self._client.capture_error(exc, {"span_id": self._span_id, "trace_id": self._trace_id})
        self.end()
        return False

    @classmethod
    def _noop(cls):
        return cls(None, "noop")


class KlauroClient:
    """The Klauro runtime telemetry client.

    Recording is non-blocking: events are enqueued under a lock and delivered by
    a background daemon thread (on a flush interval or batch threshold), on
    explicit :meth:`flush`, and at interpreter exit. Network failures never
    propagate into user code — the batch is re-queued (bounded) and ``on_error``
    is invoked.
    """

    def __init__(
        self,
        project_id=None,
        api_key=None,
        endpoint=None,
        service=None,
        service_name=None,
        environment=None,
        batch_size=50,
        flush_interval=5.0,
        max_queue_size=10000,
        transport=None,
        on_error=None,
        debug=False,
    ):
        if not project_id:
            raise ValueError(
                "init() requires project_id, e.g. init(project_id=..., api_key=..., service=...)"
            )
        self.project_id = project_id
        self.service = service or service_name
        self.environment = environment
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self.max_queue_size = max_queue_size
        self.debug = debug
        self._on_error = on_error or self._default_on_error
        self._endpoint = (endpoint or DEFAULT_ENDPOINT).rstrip("/")
        self._transport = transport or HttpTransport(self._endpoint, project_id, api_key)

        self._queue = []
        self._lock = threading.Lock()
        self._flush_now = threading.Event()
        self._stopped = threading.Event()
        self._worker = None
        if flush_interval and flush_interval > 0:
            self._worker = threading.Thread(target=self._run, name="klauro-flush", daemon=True)
            self._worker.start()
        atexit.register(self._atexit)

    # ---- public API ----

    def record_event(self, event):
        if self._stopped.is_set():
            return
        normalized = self._normalize(event)
        should_flush = False
        with self._lock:
            self._queue.append(normalized)
            if len(self._queue) > self.max_queue_size:
                # Drop oldest to bound memory; telemetry must never OOM the host.
                del self._queue[: len(self._queue) - self.max_queue_size]
            if len(self._queue) >= self.batch_size:
                should_flush = True
        if should_flush:
            self._flush_now.set()

    def record(self, name, attributes=None):
        self.record_event({"type": "custom", "signal": name, "attributes": dict(attributes or {})})

    def increment_counter(self, name, value=1, attributes=None):
        attrs = dict(attributes or {})
        attrs.update({"metric_type": "counter", "metric_value": value})
        self.record_event({"type": "custom", "signal": name, "attributes": attrs})

    def record_gauge(self, name, value, attributes=None):
        attrs = dict(attributes or {})
        attrs.update({"metric_type": "gauge", "metric_value": value})
        self.record_event({"type": "custom", "signal": name, "attributes": attrs})

    def capture_error(self, err, extra=None):
        if isinstance(err, BaseException):
            message = str(err) or err.__class__.__name__
            stack = "".join(traceback.format_exception(type(err), err, err.__traceback__))
        else:
            message = str(err)
            stack = None
        event = {"type": "error", "error_message": message}
        if stack:
            event["stack"] = stack
        event.update(extra or {})
        self.record_event(event)

    def start_span(self, name, extra=None):
        return Span(self, name, extra)

    @property
    def pending(self):
        with self._lock:
            return len(self._queue)

    def flush(self):
        """Synchronously deliver all queued events. Never raises."""
        with self._lock:
            batch = self._queue
            self._queue = []
        if not batch:
            return
        try:
            self._transport.send(batch)
            if self.debug:
                print("[klauro] delivered {} event(s)".format(len(batch)))
        except Exception as exc:  # noqa: BLE001 - telemetry must not crash the host
            self._requeue(batch)
            self._on_error(exc)

    def shutdown(self):
        """Flush and stop the background worker. Idempotent."""
        if self._stopped.is_set():
            return
        self._stopped.set()
        self._flush_now.set()
        if self._worker is not None:
            self._worker.join(timeout=self.flush_interval + 2.0)
        self.flush()

    # ---- internals ----

    def _requeue(self, batch):
        with self._lock:
            self._queue[0:0] = batch
            if len(self._queue) > self.max_queue_size:
                del self._queue[self.max_queue_size :]

    def _normalize(self, event):
        out = {
            "schema_version": SCHEMA_VERSION,
            "timestamp": _now_iso(),
        }
        if self.service is not None:
            out["service_name"] = self.service
        if self.environment is not None:
            out["environment"] = self.environment
        out.update(event)
        return out

    def _run(self):
        while not self._stopped.is_set():
            self._flush_now.wait(timeout=self.flush_interval)
            self._flush_now.clear()
            self.flush()

    def _atexit(self):
        try:
            self.shutdown()
        except Exception:  # noqa: BLE001
            pass

    def _default_on_error(self, exc):
        if self.debug:
            print("[klauro] delivery failed: {}".format(exc))
