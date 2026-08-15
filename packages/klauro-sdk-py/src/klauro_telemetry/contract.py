SCHEMA_VERSION = "1.0.0"
DEFAULT_ENDPOINT = "https://mcp.klauro.com"
EVENT_TYPES = ("request", "error", "exit", "log", "custom")

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
    from urllib.parse import quote

    return "/api/telemetry/runtime-events/{}".format(quote(str(project_id), safe=""))
