import json
import urllib.request



class HttpTransport:
    def __init__(self, endpoint, project_id):
        self.url = endpoint.rstrip("/") + "/events/" + project_id

    def send(self, events):
        body = json.dumps({"events": events}).encode("utf-8")
        req = urllib.request.Request(self.url, data=body, method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.read()

