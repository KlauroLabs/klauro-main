import threading
import time

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

        return len(events)

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


def test_concurrent_flushes_serialize_transport_delivery():
    class ConcurrentTransport:
        def __init__(self):
            self.active = 0
            self.maximum_active = 0
            self.lock = threading.Lock()

        def send(self, events):
            with self.lock:
                self.active += 1
                self.maximum_active = max(self.maximum_active, self.active)
            time.sleep(0.02)
            with self.lock:
                self.active -= 1

            return len(events)
    transport = ConcurrentTransport()
    client = make_client(transport)
    client.record("first")
    first = threading.Thread(target=client.flush)
    first.start()
    client.record("second")
    second = threading.Thread(target=client.flush)
    second.start()
    first.join()
    second.join()
    assert transport.maximum_active == 1
    assert client.pending == 0
    client.shutdown()


def test_chunks_large_queues_and_preserves_event_ids_across_retry():
    class RetryTransport:
        def __init__(self):
            self.batches = []

        def send(self, events):
            self.batches.append(list(events))
            if len(self.batches) == 1:
                raise RuntimeError("ambiguous network failure")
            return len(events)

    transport = RetryTransport()
    client = make_client(
        transport,
        batch_size=10000,
        retry_attempts=2,
        retry_base_delay=0,
    )
    for index in range(1205):
        client.record("event-{}".format(index))
    client.flush()
    assert [len(batch) for batch in transport.batches] == [1000, 1000, 205]
    assert [event["event_id"] for event in transport.batches[0]] == [
        event["event_id"] for event in transport.batches[1]
    ]
    assert len({event["event_id"] for batch in transport.batches[1:] for event in batch}) == 1205
    assert client.pending == 0


def test_requeues_chunk_when_server_acknowledges_partial_batch():
    class PartialTransport:
        def send(self, events):
            return len(events) - 1

    errors = []
    client = make_client(
        PartialTransport(),
        retry_attempts=1,
        on_error=lambda error: errors.append(error),
    )
    client.record("one")
    client.record("two")
    client.flush()
    assert client.pending == 2
    assert "acknowledged 1/2" in str(errors[0])

@pytest.mark.parametrize("acknowledgement", [None, "1", 0.5, True])
def test_retries_then_requeues_invalid_acknowledgement_with_stable_ids(acknowledgement):
    class InvalidTransport:
        def __init__(self):
            self.batches = []

        def send(self, events):
            self.batches.append(list(events))
            return acknowledgement

    transport = InvalidTransport()
    errors = []
    client = make_client(
        transport,
        retry_attempts=2,
        retry_base_delay=0,
        on_error=lambda error: errors.append(error),
    )
    client.record("one")
    client.flush()
    assert len(transport.batches) == 2
    assert [event["event_id"] for event in transport.batches[0]] == [
        event["event_id"] for event in transport.batches[1]
    ]
    assert client.pending == 1
    assert "integer event_count" in str(errors[0])


def test_ambiguous_acknowledgement_retries_with_same_ids_then_succeeds():
    class RetryTransport:
        def __init__(self):
            self.batches = []

        def send(self, events):
            self.batches.append(list(events))
            return None if len(self.batches) == 1 else len(events)

    transport = RetryTransport()
    client = make_client(transport, retry_attempts=2, retry_base_delay=0)
    client.record("one")
    client.flush()
    assert [event["event_id"] for event in transport.batches[0]] == [
        event["event_id"] for event in transport.batches[1]
    ]
    assert client.pending == 0

@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (b"", "JSON acknowledgement"),
        (b"{", "not valid JSON"),
        (b"{}", "integer event_count"),
        (b'{"event_count": "1"}', "integer event_count"),
        (b'{"event_count": true}', "integer event_count"),
    ],
)
def test_http_transport_rejects_missing_or_malformed_acknowledgements(monkeypatch, payload, message):
    class Response:
        status = 200

        def getcode(self):
            return self.status

        def read(self):
            return payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response())
    from klauro_telemetry.client import HttpTransport

    with pytest.raises(RuntimeError, match=message):
        HttpTransport("https://example.invalid", "project").send([{"event_id": "event-1"}])
