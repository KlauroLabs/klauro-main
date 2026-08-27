import klauro_telemetry as klauro


def teardown_function():
    klauro.shutdown()


class RecordingTransport:
    def __init__(self):
        self.batches = []

    def send(self, events):
        self.batches.append(list(events))

        return len(events)

def test_noop_before_init():
    klauro.shutdown()  # ensure clean
    # None of these raise when uninitialized.
    klauro.record("x")
    klauro.record_event({"type": "custom", "signal": "y"})
    klauro.capture_error(Exception("z"))
    klauro.increment_counter("c")
    klauro.record_gauge("g", 1)
    span = klauro.start_span("s")
    span.set_attribute("k", "v")
    span.end()
    klauro.flush()
    assert klauro.get_client() is None


def test_init_and_global_record():
    t = RecordingTransport()
    client = klauro.init(project_id="p", flush_interval=0, transport=t)
    assert klauro.get_client() is client
    klauro.record("booted")
    klauro.flush()
    assert t.batches[0][0]["signal"] == "booted"
    klauro.shutdown()
    assert klauro.get_client() is None
