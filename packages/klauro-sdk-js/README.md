# @klauro/telemetry

Runtime telemetry SDK for Node.js / TypeScript. Emits **CAS-correlated runtime events** — requests, errors, spans, counters, gauges — so production signal maps straight back onto your Klauro static analysis. This is the runtime counterpart to Klauro's static instrumentation inventory: events carry the same identifiers (`entry_point_id`, `route`, `signal`, `node_id`) the backend correlates on.
Release status: **private-beta release candidate**. The source-bound npm tarball passes build, archive allowlist, digest, and clean-install verification. Registry publication is not yet proven; use `npm install @klauro/telemetry` only after the release receipt and registry publication are completed for the same source SHA.

Delivery succeeds only when the server returns JSON with an integer `event_count` exactly equal to the submitted batch length. Missing, malformed, or partial acknowledgements retry the same preassigned event IDs.


## Install

```bash
npm install @klauro/telemetry
```

## Instrument in 3 lines

```ts
import { init } from '@klauro/telemetry';
import { klauroExpress } from '@klauro/telemetry/express';

init({ apiKey: process.env.KLAURO_API_KEY, projectId: 'my-project', service: 'items-api', environment: 'production' });
app.use(klauroExpress());
```

That's it. Every completed request is now emitted to Klauro, batched and non-blocking.

## Framework middlewares

| Framework | Import | Wire-up |
|-----------|--------|---------|
| Express   | `@klauro/telemetry/express` | `app.use(klauroExpress())` (+ `app.use(klauroExpressErrorHandler())` after routes) |
| Fastify   | `@klauro/telemetry/fastify` | `await app.register(klauroFastify())` |
| Koa       | `@klauro/telemetry/koa`     | `app.use(klauroKoa())` |
| NestJS    | `@klauro/telemetry/nestjs`  | `app.useGlobalInterceptors(new KlauroInterceptor())` |

## Manual API

```ts
import { record, startSpan, captureError, incrementCounter, recordGauge, flush } from '@klauro/telemetry';

record('cache.miss', { key: 'user:42' });          // custom event
incrementCounter('orders.created', 1);              // counter
recordGauge('queue.depth', 128);                    // gauge

const span = startSpan('db.query', { node_id: 'n42' });
try {
  await db.query(...);
} catch (err) {
  captureError(err, { route: '/items/:id' });
} finally {
  span.end();                                       // records an `exit` event with duration
}

await flush(); // force delivery (also happens on batch size, interval, and process exit)
```

Every call is a **safe no-op if `init()` was never called** — you can leave instrumentation in library code without forcing consumers to configure telemetry.

## What gets captured

Events use the canonical CAS runtime event schema (see `get_runtime_event_contract`):

- **`request`** — inbound HTTP: `method`, `route`, `path`, `status_code`, `duration_ms`
- **`error`** — thrown errors and 5xx: `error_message`, `stack`
- **`exit`** — spans and outbound calls: `signal`, `duration_ms`, `trace_id`, `span_id`
- **`custom`** — named events, counters, gauges
- Correlation ids passed through verbatim: `entry_point_id`, `exit_point_id`, `call_chain_id`, `node_id`, `static_id`, `signal`

## Delivery & safety

- **Batched**: flushes at `batchSize` (default 50), on a `flushInterval` (default 5s, timer is `unref`'d), and on `beforeExit` / `SIGTERM` / `SIGINT`.
- **Non-blocking**: recording enqueues and returns; delivery is async.
- **Never crashes the host**: network/HTTP failures re-queue the batch (bounded by `maxQueueSize`) and call your `onError` handler.

## How it shows up in Klauro

Events POST to `POST {endpoint}/api/telemetry/runtime-events/:projectId` with body `{ events: [...] }`. Once ingested they appear in:

- **`get_runtime_observations`** — the raw ingested events and their CAS correlations
- **`correlate_runtime_event`** — maps an event back to entry points, exit points, call chains, and `runtime_static_links`
- **`get_runtime_static_links`** — flips a link's `telemetry_status` from `instrumentable` to `observed` once real signal arrives

## Configuration

```ts
init({
  projectId: 'my-project',   // required
  apiKey: '...',             // Bearer token
  endpoint: 'https://mcp.klauro.com', // default
  service: 'items-api',
  environment: 'production',
  batchSize: 50,
  flushInterval: 5000,       // ms; 0 disables the timer
  maxQueueSize: 10000,
  onError: (err) => { /* your logging */ },
});
```
