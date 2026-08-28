# klauro-telemetry (Python)

Runtime telemetry SDK for Python. Emits **CAS-correlated runtime events** — requests, errors, spans, counters, gauges — so production signal maps straight back onto your Klauro static analysis. Runtime counterpart to Klauro's static instrumentation inventory: events carry the same identifiers (`entry_point_id`, `route`, `signal`, `node_id`) the backend correlates on.

Zero required dependencies (delivery uses stdlib `urllib`).
Release status: **private-beta release candidate**. The source-bound wheel passes build, archive allowlist, digest, and clean-install verification. PyPI publication is not yet proven; use `pip install klauro-telemetry` only after the release receipt and registry publication are completed for the same source SHA.

Delivery succeeds only when the server returns JSON with an integer `event_count` exactly equal to the submitted batch length. Missing, malformed, or partial acknowledgements retry the same preassigned event IDs.


## Install

```bash
pip install klauro-telemetry
# with a framework integration:
pip install "klauro-telemetry[fastapi]"   # or [flask], [django]
```

## Instrument in 3 lines

```python
from klauro_telemetry import init
from klauro_telemetry.middleware import KlauroASGIMiddleware

init(api_key=os.environ["KLAURO_API_KEY"], project_id="my-project", service="items-api", environment="production")
app.add_middleware(KlauroASGIMiddleware)   # FastAPI / Starlette
```

## Framework integrations

| Framework | Wire-up |
|-----------|---------|
| FastAPI / Starlette | `app.add_middleware(KlauroASGIMiddleware)` |
| Flask     | `from klauro_telemetry.middleware import init_flask; init_flask(app)` |
| Django    | add `"klauro_telemetry.middleware.KlauroDjangoMiddleware"` to `MIDDLEWARE` |

## Manual API

```python
from klauro_telemetry import record, start_span, capture_error, increment_counter, record_gauge, flush

record("cache.miss", {"key": "user:42"})     # custom event
increment_counter("orders.created", 1)        # counter
record_gauge("queue.depth", 128)              # gauge

with start_span("db.query", {"node_id": "n42"}) as span:   # records an `exit` event with duration
    span.set_attribute("table", "items")
    ...  # exceptions inside the block are captured automatically

try:
    ...
except Exception as err:
    capture_error(err, {"route": "/items/:id"})

flush()  # force delivery (also happens on batch size, interval, and interpreter exit)
```

Every call is a **safe no-op if `init()` was never called**.

## What gets captured

Events use the canonical CAS runtime event schema (see `get_runtime_event_contract`):

- **`request`** — inbound HTTP: `method`, `route`, `path`, `status_code`, `duration_ms`
- **`error`** — exceptions and 5xx: `error_message`, `stack`
- **`exit`** — spans / outbound calls: `signal`, `duration_ms`, `trace_id`, `span_id`
- **`custom`** — named events, counters, gauges
- Correlation ids passed through verbatim: `entry_point_id`, `exit_point_id`, `call_chain_id`, `node_id`, `static_id`, `signal`

## Delivery & safety

- **Batched**: a background daemon thread flushes at `batch_size` (default 50) and on `flush_interval` (default 5s), plus `atexit`.
- **Non-blocking**: recording enqueues under a lock and returns.
- **Never crashes the host**: delivery failures re-queue the batch (bounded by `max_queue_size`) and call your `on_error`.

## How it shows up in Klauro

Events POST to `POST {endpoint}/api/telemetry/runtime-events/:projectId` with body `{"events": [...]}`. Once ingested they appear in `get_runtime_observations`, correlate via `correlate_runtime_event`, and flip `runtime_static_links` from `instrumentable` to `observed`.

## Configuration

```python
init(
    project_id="my-project",   # required
    api_key="...",
    endpoint="https://mcp.klauro.com",  # default
    service="items-api",
    environment="production",
    batch_size=50,
    flush_interval=5.0,        # seconds; 0 disables the background worker
    max_queue_size=10000,
    on_error=lambda err: ...,
)
```
