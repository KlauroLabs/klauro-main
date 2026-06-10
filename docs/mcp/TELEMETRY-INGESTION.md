# Telemetry Ingestion

Klauro layers real runtime behavior onto the static CAS graph. The `ingest_telemetry` MCP tool accepts batches of runtime events in an OTEL-compatible JSON shape, correlates each event onto CAS nodes, entry points, exit points, call chains, and `runtime_static_links` using the same correlation core that powers runtime simulation, and persists them per analysis with `source: "ingested"`.

Provenance is non-negotiable: ingested telemetry and simulated telemetry never mix silently. Runtime tools return ingested data by default and only include simulated observations when explicitly asked. Every observation and every operational priority carries a `source` field (`ingested`, `simulated`, or `mixed` for priorities aggregating both).

## When to use

- A service is running and you want production errors, latency, and volume to drive the next-work ranking in `get_operational_priorities`.
- An SDK, OTEL collector exporter, log shipper, or agent has runtime events and needs to map them back to static code structure.
- You want to prove or challenge what static analysis inferred: which routes are actually hit, which inferred risks actually fail in production.

## Event shape

`ingest_telemetry` takes `path` (the analyzed project path), `events` (max 1000 per call), and optional `persist` (default true; false correlates without storing).

Each event:

```json
{
  "kind": "request | error | log | metric",
  "timestamp": "2026-06-10T14:03:22.000Z",
  "name": "http:POST:/work_orders",
  "service_name": "work-orders-api",
  "environment": "production",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "parent_span_id": "57e1d8c9a2b40f11",
  "method": "POST",
  "route": "/work_orders",
  "path": "/work_orders",
  "status": 500,
  "duration_ms": 184,
  "function_hint": "create",
  "file_hint": "app/controllers/work_orders_controller.rb",
  "error": {
    "type": "NoMethodError",
    "message": "undefined method 'permit' for nil:NilClass",
    "stack_top_frames": [
      { "file": "app/controllers/work_orders_controller.rb", "line": 47, "function": "work_order_params" },
      { "file": "app/controllers/work_orders_controller.rb", "line": 15, "function": "create" }
    ]
  },
  "volume": 12,
  "attributes": { "region": "us-east-1" }
}
```

Only `kind` is required. Everything else improves correlation:

| Field | Purpose |
|-------|---------|
| `kind` | `request`, `error`, `log`, or `metric` (`metric` is stored as a custom event) |
| `timestamp` | ISO time of the event; defaults to ingestion time |
| `name` | Span, signal, or metric name. Using a CAS `runtime_signal` such as `http:POST:/work_orders` gives an exact runtime-link match |
| `method`, `route`, `path` | Matched against CAS HTTP entry points, including `:param` and `{param}` patterns |
| `status` | HTTP status code; 5xx counts toward error volume |
| `duration_ms` | Events at or above 1000 ms count as slow in priorities |
| `function_hint`, `file_hint` | Resolved against CAS node names and source files when there is no route or stack |
| `error.stack_top_frames` | Frames (objects or raw strings) resolved against CAS node source files and line ranges, most specific first |
| `volume` | Pre-aggregated count this event represents, for sampled or batched pipelines |
| `trace_id`, `span_id`, `parent_span_id` | Enable `get_runtime_trace` replay |

## Example MCP call

```json
{
  "tool": "ingest_telemetry",
  "arguments": {
    "path": "/work/repos/work-orders",
    "events": [
      {
        "kind": "error",
        "timestamp": "2026-06-10T14:03:22.000Z",
        "method": "POST",
        "route": "/work_orders",
        "status": 500,
        "duration_ms": 184,
        "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
        "error": {
          "type": "NoMethodError",
          "message": "undefined method 'permit' for nil:NilClass",
          "stack_top_frames": [
            { "file": "app/controllers/work_orders_controller.rb", "line": 47, "function": "work_order_params" }
          ]
        }
      }
    ]
  }
}
```

The result reports correlation quality and never drops unmatched events:

```json
{
  "ingestion_id": "ingest_1765375402_x8k2mf4a",
  "source": "ingested",
  "event_count": 1,
  "persisted": true,
  "correlation_summary": { "matched": 1, "partial": 0, "unmatched": 0 },
  "matched_targets": [
    {
      "id": "node-work-order-params",
      "label": "method:work_order_params",
      "type": "node",
      "file": "app/controllers/work_orders_controller.rb",
      "observations": 1,
      "errors": 1,
      "slow_events": 0,
      "estimated_volume": 1
    }
  ],
  "unmatched": { "count": 0, "top_hints": [] }
}
```

Unmatched events are stored with `correlation.status: "unmatched"` and surfaced in `unmatched.top_hints` (for example `POST /ghost-route x12`) so instrumentation gaps are visible instead of silent.

## How ingested data flows into runtime tools

- `get_runtime_observations` returns ingested observations by default. Pass `source: "simulated"` or `source: "all"` to see simulated data; the response always includes `ingested_count`, `simulated_count`, and per-observation `source`.
- `get_operational_priorities` ranks work from ingested telemetry plus static risk by default. Pass `include_simulated: true` to mix in simulated observations; each priority carries `source: "ingested" | "simulated" | "mixed"`. Each priority's `static_target.file` is a CAS-resolved file you can hand to `get_agent_work_packet`.
- `get_runtime_trace` replays a `trace_id` from ingested data by default, with the same `source` opt-in.
- `simulate_runtime_telemetry` remains the planning surface; everything it stores is marked `source: "simulated"` and never masquerades as production truth.

## Storage and retention

Ingested observations are persisted under the analysis storage directory (`~/.klauro/analyses/<project>/ingested-telemetry/` unless `KLAURO_STORAGE_PATH` is set), one JSON file per day, newest first. Each ingest appends to the current day file (capped at 5000 observations per day) and compacts the window by deleting day files older than 14 days.

## Mapping from an SDK or OTEL collector exporter

The shape is deliberately span-like so an exporter is a thin transform:

| OTEL concept | Telemetry event field |
|--------------|-----------------------|
| Span end time | `timestamp` |
| Span name | `name` |
| `service.name` resource attribute | `service_name` |
| `deployment.environment` | `environment` |
| Trace/span/parent ids | `trace_id`, `span_id`, `parent_span_id` |
| `http.request.method` | `method` |
| `http.route` | `route` |
| `url.path` | `path` |
| `http.response.status_code` | `status` |
| Span duration | `duration_ms` |
| Span status ERROR + exception event | `kind: "error"` with `error.type` (`exception.type`), `error.message` (`exception.message`), `error.stack_top_frames` (top frames of `exception.stacktrace`) |
| `code.filepath` / `code.function` | `file_hint` / `function_hint` |
| Metric data point value | `kind: "metric"` with `volume` |
| Remaining attributes | `attributes` |

A custom SDK does the same: wrap request handlers, emit one event per request or error, and batch them to `ingest_telemetry`. `get_runtime_event_contract` and `get_runtime_sdk_package` generate CAS-specific signal names and a TypeScript client whose `runtime_signal` values (`name`) correlate exactly.

## Drop-in middleware

Two dependency-free middlewares live in `packages/analyzer-core/src/sdk/` and emit this event shape directly from real traffic. Both batch in memory (default: flush at 20 events or every 5 seconds, whichever comes first) and support two transports: append NDJSON to a file (one event JSON per line) or POST `{ "events": [...] }` to an HTTP endpoint. File transport is the working path today: read the NDJSON lines and pass them as the `events` argument of `ingest_telemetry`. The HTTP transport targets the planned hosted ingestion endpoint.

### Express (`sdk/javascript/klauro-express-middleware.ts`)

```ts
import { createKlauroExpressTelemetry } from './sdk/javascript/klauro-express-middleware';

const telemetry = createKlauroExpressTelemetry({
  serviceName: 'inventory-api',
  environment: 'production',
  filePath: '/var/log/inventory-api/klauro-telemetry.ndjson',
  // endpoint: 'https://ingest.example.com/telemetry',
  batchSize: 20,
  flushIntervalMs: 5000,
});

app.use(telemetry.requestHandler);   // before routes
// ...routes...
app.use(telemetry.errorHandler);     // after routes, before the error renderer
process.on('SIGTERM', () => telemetry.shutdown());
```

Captured per request on response finish: `method`, `route` (the matched Express pattern from `req.route.path` prefixed with `req.baseUrl`, such as `POST /items/:id/reserve`, never the raw URL), `path`, `status`, `duration_ms`, `timestamp`, `service_name`, `environment`. Thrown handler errors (recorded by `errorHandler`) and 5xx responses become `kind: "error"`; thrown errors carry `error.type`, `error.message`, and the top 5 raw stack frame strings, which the ingestion side parses into file/line/function for CAS node correlation.

### Rails / Rack (`sdk/ruby/klauro_rack_middleware.rb`)

```ruby
require_relative "klauro_rack_middleware"

# config/application.rb
config.middleware.insert_before 0, KlauroRackMiddleware,
  service_name: "work-orders-api",
  environment: Rails.env,
  file_path: Rails.root.join("log", "klauro-telemetry.ndjson").to_s,
  # endpoint: "https://ingest.example.com/telemetry",
  batch_size: 20,
  flush_interval: 5
```

Captured per request: the same fields, with `route` from `action_dispatch.route_uri_pattern` (Rails 7.1+) or `sinatra.route`, format suffix stripped. When Rails routing params are present it also emits `file_hint` (`app/controllers/<controller>_controller.rb`) and `function_hint` (the action), so events correlate to controller nodes even without a stack. Raised exceptions become `kind: "error"` with `error.type`, `error.message`, and the top 5 backtrace frames parsed into `{ file, line, function }` objects, then re-raise. A background thread flushes on the interval; call `shutdown` at exit for a final flush.

## Verifying end to end

`npm run telemetry-ingestion-proof` from `apps/mcp-server/` analyzes the `fixtures/analysis-truth/rails-work-orders` fixture with AI features disabled, ingests a realistic 50-event batch (POST `/work_orders` errors with controller stack frames plus healthy traffic), and asserts that the top operational priority has `source: "ingested"`, at least 30 errors, and a `static_target.file` that resolves on disk.

## Implemented vs planned

Implemented:

- `ingest_telemetry` MCP tool with batch correlation stats and top unmatched hints.
- Correlation onto CAS via runtime signals, route patterns, explicit static ids, file/function hints, and stack frame paths, shared with `simulate_runtime_telemetry` and `correlate_runtime_event`.
- Per-day rolling persistence under the analysis storage directory with 14-day retention.
- Provenance (`source: "ingested" | "simulated"`) on observations, runtime tool responses, and operational priorities; simulated data is opt-in everywhere.
- Express middleware (`packages/analyzer-core/src/sdk/javascript/klauro-express-middleware.ts`) and Rack middleware (`packages/analyzer-core/src/sdk/ruby/klauro_rack_middleware.rb`) that capture real traffic in this event shape with batching and NDJSON file or HTTP POST transport.

Planned:

- A hosted HTTP ingestion endpoint so exporters can POST without an MCP client (the middlewares' `endpoint` transport targets it; until then, feed the NDJSON file to `ingest_telemetry`).
- Publishing the middlewares as installable packages (npm, gem) instead of vendored single files.
- A packaged OTEL collector exporter and SDKs for additional languages and frameworks.
- Aggregation beyond per-day files (rollups, percentile latency, error-rate baselines).
- Telemetry-versus-static drift reports that flag routes and flows static analysis inferred but production never exercises, and vice versa.
