import pytest

from klauro_telemetry import KlauroClient


class RecordingTransport:
    def __init__(self, fail=False):
        self.batches = []
        self.fail = fail

    def send(self, events):
        self.batches.append(list(events))
        if self.fail:
            raise RuntimeError("network down")


def make_client(transport, **kwargs):
    # flush_interval=0 disables the background worker so tests are deterministic.
    return KlauroClient(project_id="p", flush_interval=0, transport=transport, **kwargs)


def test_normalizes_events():
    t = RecordingTransport()
    c = make_client(t, service="items-api", environment="test")
    c.record("cache.hit", {"key": "x"})
    c.flush()
    ev = t.batches[0][0]
    assert ev["type"] == "custom"
    assert ev["signal"] == "cache.hit"
    assert ev["schema_version"] == "1.0.0"
    assert ev["service_name"] == "items-api"
    assert ev["environment"] == "test"
    assert ev["attributes"] == {"key": "x"}
    assert "timestamp" in ev


def test_auto_flush_at_batch_size():
    t = RecordingTransport()
    c = make_client(t, batch_size=3)
    c.record("a")
    c.record("b")
    assert c.pending == 2
    c.record("c")  # reaching batch size sets flush signal; with no worker, flush here
    c.flush()
    assert t.batches
    assert len(t.batches[-1]) >= 3


def test_requeue_on_failure_never_raises():
    t = RecordingTransport(fail=True)
    errors = []
    c = make_client(t, on_error=lambda e: errors.append(e))
    c.record("a")
    c.flush()
    assert c.pending == 1  # retained for retry
    assert len(errors) == 1


def test_capture_error():
    t = RecordingTransport()
    c = make_client(t)
    try:
        raise TypeError("boom")
    except TypeError as exc:
        c.capture_error(exc, {"route": "/x"})
    c.flush()
    ev = t.batches[0][0]
    assert ev["type"] == "error"
    assert ev["error_message"] == "boom"
    assert ev["route"] == "/x"
    assert "TypeError" in ev["stack"]


def test_start_span_records_exit():
    t = RecordingTransport()
    c = make_client(t)
    span = c.start_span("db.query", {"node_id": "n1"})
    span.set_attribute("table", "items")
    span.end()
    span.end()  # idempotent
    c.flush()
    assert len(t.batches[0]) == 1
    ev = t.batches[0][0]
    assert ev["type"] == "exit"
    assert ev["signal"] == "db.query"
    assert ev["node_id"] == "n1"
    assert ev["attributes"]["table"] == "items"
    assert isinstance(ev["duration_ms"], float)
    assert ev["span_id"] and ev["trace_id"]


def test_span_context_manager_captures_exception():
    t = RecordingTransport()
    c = make_client(t)
    with pytest.raises(ValueError):
        with c.start_span("work"):
            raise ValueError("nope")
    c.flush()
    types = [e["type"] for e in t.batches[0]]
    assert "error" in types
    assert "exit" in types


def test_counter_and_gauge():
    t = RecordingTransport()
    c = make_client(t)
    c.increment_counter("orders", 2)
    c.record_gauge("queue_depth", 17)
    c.flush()
    counter, gauge = t.batches[0]
    assert counter["attributes"]["metric_type"] == "counter"
    assert counter["attributes"]["metric_value"] == 2
    assert gauge["attributes"]["metric_type"] == "gauge"
    assert gauge["attributes"]["metric_value"] == 17


def test_max_queue_size_bounds_memory():
    t = RecordingTransport()
    c = make_client(t, batch_size=10**9, max_queue_size=5)
    for i in range(20):
        c.record("e{}".format(i))
    assert c.pending == 5


def test_requires_project_id():
    with pytest.raises(ValueError):
        KlauroClient(flush_interval=0)
