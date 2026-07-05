"""CAS runtime event contract constants and the canonical event field set.

Mirrors the JS SDK's ``types.ts`` and the backend ``get_runtime_event_contract``.
"""

SCHEMA_VERSION = "1.0.0"
DEFAULT_ENDPOINT = "https://mcp.klauro.com"
EVENT_TYPES = ("request", "error", "exit", "log", "custom")

# All recognized CAS runtime event fields. Used to keep events clean and to
# document the contract in one place. `type` is required; everything else is
# optional and correlation-relevant.
EVENT_FIELDS = (
    "type",
    "timestamp",
    "schema_version",
    "service_name",
    "environment",
    "signal",
    "static_id",
    "node_id",
    "entry_point_id",
    "exit_point_id",
    "call_chain_id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "method",
    "route",
    "path",
    "status_code",
    "duration_ms",
    "error_message",
    "stack",
    "attributes",
)


def ingest_path(project_id):
    """Return the ingest path for a project id (path portion only)."""
    from urllib.parse import quote

    return "/api/telemetry/runtime-events/{}".format(quote(str(project_id), safe=""))
