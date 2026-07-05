import json
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from klauro_telemetry import KlauroClient


def test_events_round_trip_over_the_wire():
    """Stand up a real HTTP server implementing the exact CAS ingest contract
    and assert events delivered by the default HttpTransport round-trip."""
    received = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            m = re.match(r"^/api/telemetry/runtime-events/(.+)$", self.path)
            if not m:
                self.send_response(404)
                self.end_headers()
                return
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length))
            received.append(
                {
                    "project_id": m.group(1),
                    "events": body["events"],
                    "auth": self.headers.get("authorization"),
                }
            )
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"matched": len(body["events"]), "unmatched": 0}).encode())

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = KlauroClient(
            project_id="proof-of-concept",
            api_key="test-key",
            endpoint="http://127.0.0.1:{}".format(port),
            service="items-api",
            environment="e2e",
            flush_interval=0,
        )
        client.record_event(
            {
                "type": "request",
                "signal": "registerTool analyze_codebase",
                "entry_point_id": "entry_mcp_tool_analyze_codebase_src_server_ts_891",
                "method": "registerTool",
                "route": "analyze_codebase",
                "status_code": 200,
                "duration_ms": 12,
            }
        )
        try:
            raise RuntimeError("downstream timeout")
        except RuntimeError as exc:
            client.capture_error(exc, {"route": "/items/:id"})
        client.start_span("db.query", {"node_id": "n42"}).end()

        client.flush()

        assert len(received) == 1
        assert received[0]["project_id"] == "proof-of-concept"
        assert received[0]["auth"] == "Bearer test-key"
        events = received[0]["events"]
        assert len(events) == 3
        by_type = {e["type"]: e for e in events}
        assert by_type["request"]["entry_point_id"] == "entry_mcp_tool_analyze_codebase_src_server_ts_891"
        assert by_type["request"]["schema_version"] == "1.0.0"
        assert by_type["request"]["service_name"] == "items-api"
        assert by_type["error"]["error_message"] == "downstream timeout"
        assert by_type["exit"]["node_id"] == "n42"
        assert client.pending == 0
    finally:
        server.shutdown()
