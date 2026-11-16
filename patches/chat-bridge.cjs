// Workerov: the dashboard server passes the desktop app's chat to the full-access link (apply after dashboard-chat-theme.cjs).
//  - POST /api/action {action:"chat_call"}: goes through the normal action gate (token header, origin check, no read-only
//    link) and the audit log (which records the call name only, never the prompt or an image)
//  - GET /api/chat/events (server-sent events), /api/chat/status and /chat/<file>: the chat page itself. Full access only,
//    and only from another device: a read-only link or a request from this computer is refused (the app has the chat here)
//  - the app listens on 127.0.0.1 and writes job/chat-bridge.json (port + secret); with the app closed there is no chat
const fs = require('fs');
const S = '.claude/scripts/dashboard-server.py';
let s = fs.readFileSync(S, 'utf8').replace(/\r\n/g, '\n');
const must = (a) => { if (!s.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 90)); };
const sub = (a, b) => { must(a); s = s.replace(a, () => b); };

if (!s.includes('def wv_chat_call')) {
  sub('\ndef wv_run_action(action, req, tid):', String.raw`
def wv_chat_bridge():
    try:
        d = json.loads((REPO_ROOT / "job" / "chat-bridge.json").read_text(encoding="utf-8"))
        return int(d["port"]), str(d["secret"])
    except Exception:
        return None


def wv_chat_request(method, path, body=None, timeout=60):
    b = wv_chat_bridge()
    if not b:
        return 503, {"error": "Open the Workerov app on your computer to use the chat."}
    import http.client
    try:
        conn = http.client.HTTPConnection("127.0.0.1", b[0], timeout=timeout)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        conn.request(method, path, body=data, headers={"X-Bridge-Secret": b[1], "Content-Type": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            return resp.status, json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return resp.status, {"error": "The chat gave an unreadable answer."}
    except Exception:
        return 503, {"error": "The Workerov app is not answering. Open it on your computer."}


def wv_chat_call(req):
    import re as _re
    call = str(req.get("call") or "")
    if not _re.fullmatch(r"[A-Za-z]{2,30}", call):
        return 400, {"error": "Bad chat action."}
    return wv_chat_request("POST", "/call", {"call": call, "args": req.get("args")}, timeout=180)


def wv_chat_asset(name):
    import re as _re
    import http.client
    b = wv_chat_bridge()
    if not b or not _re.fullmatch(r"[a-z\-]{3,20}\.(html|css|js)", name):
        return 404, "text/plain", b"Not found"
    try:
        conn = http.client.HTTPConnection("127.0.0.1", b[0], timeout=10)
        conn.request("GET", "/asset/" + name, headers={"X-Bridge-Secret": b[1]})
        r = conn.getresponse()
        data = r.read()
        ctype = r.getheader("content-type") or "text/plain"
        conn.close()
        return r.status, ctype, data
    except Exception:
        return 503, "text/plain", b"The Workerov app is not answering."

` + '\ndef wv_run_action(action, req, tid):');
  sub('WV_ACTIONS = (', 'WV_ACTIONS = ("chat_call", ');
  sub('def wv_run_action(action, req, tid):\n', 'def wv_run_action(action, req, tid):\n    if action == "chat_call":\n        return wv_chat_call(req)\n');
  // audit: the call name only
  sub('            params = {k: v for k, v in req.items() if k not in ("action", "ticket", "key")}\n',
    '            params = {k: v for k, v in req.items() if k not in ("action", "ticket", "key")}\n            if action == "chat_call":\n                params = {"call": str(req.get("call") or "")[:30]}\n');
  // SSE proxy method
  sub('    def do_GET(self):\n', String.raw`    def _chat_events(self):
        b = wv_chat_bridge()
        if not b:
            self._send_json(503, {"error": "Open the Workerov app on your computer to use the chat."})
            return
        import http.client
        try:
            conn = http.client.HTTPConnection("127.0.0.1", b[0], timeout=40)
            conn.request("GET", "/events", headers={"X-Bridge-Secret": b[1]})
            resp = conn.getresponse()
        except Exception:
            self._send_json(503, {"error": "The Workerov app is not answering."})
            return
        if resp.status != 200:
            self._send_json(resp.status, {"error": "The chat is switched off in the app."})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                chunk = resp.read1(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def do_GET(self):
`);
  sub('        if path == "/api/events":\n            self._handle_events()\n            return\n', String.raw`        if path in ("/api/chat/status", "/api/chat/events") or path.startswith("/chat/"):
            if self._is_viewer() or self._is_local():
                self._send_json(403, {"error": "The chat is only for the full-access link, from another device."})
                return
            if path == "/api/chat/status":
                code, payload = wv_chat_request("GET", "/status", timeout=5)
                self._send_json(code, payload)
                return
            if path == "/api/chat/events":
                self._chat_events()
                return
            code, ctype, data = wv_chat_asset(path[len("/chat/"):] or "chat.html")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/api/events":
            self._handle_events()
            return
`);
  fs.writeFileSync(S, s);
}
console.log('chat bridge patch applied');
