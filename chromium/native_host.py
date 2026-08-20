#!/usr/bin/env python3
"""Native messaging host for Tab Share. Caches tabs pushed from the extension
and serves them over HTTP on port 8766. Also relays commands back to the extension."""

import json
import re
import struct
import sys
import threading
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler

state = {"data": "{}"}
lock = threading.Lock()
pending = {}  # id -> threading.Event, result
pending_lock = threading.Lock()
write_lock = threading.Lock()

PORT = 8766

# ---- CORS policy ----------------------------------------------------------
# Localhost origins may reach every endpoint. The file:// interface (tracker.html
# split-tab view) is served from disk, so browsers send it as `Origin: null`; it
# is only allowed to reach the low-risk endpoints it actually needs (/tabs, /navigate).
# Sensitive endpoints (/eval, /open, /extract, /close, ...) are localhost-only.
# curl (our agent) sends no Origin header and ignores CORS entirely, so it is
# unaffected — this only constrains what browser pages of other origins can call.
#
# For `Origin: null` specifically, /tabs is allowed from either member of the
# split pair (so the background pane can poll), while /navigate requires the
# requester to be the *active* (focused) file:// tab.
# Localhost and no-Origin callers are unaffected.
_LOCALHOST_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
# Endpoints safe enough to also expose to the file:// (Origin: null) split-tab UI.
FILE_OK_PATHS = frozenset({"/tabs", "/navigate"})
# Sentinel reasons returned to a null-origin caller instead of real tab data.
NO_SPLIT_TABS = "NO_SPLIT_TABS"       # no split-view pair exists right now
NOT_ALLOWED = "NOT_ALLOWED"           # target tab isn't the focused tab or its partner


def _cached_tabs():
    """Parse the last snapshot pushed from the extension. (activeTab, tabs) or
    (None, []) if nothing has been cached yet."""
    with lock:
        raw = state["data"]
    try:
        data = json.loads(raw)
    except Exception:
        return None, []
    return data.get("activeTab"), (data.get("tabs") or [])


def _focused_split_pair():
    """(active_tab_id, partner_tab_id) for the tab in focus's split-view partner, or
    (None, None) if there is no active tab, or it isn't part of a valid split pair
    right now."""
    active, tabs = _cached_tabs()
    if not active:
        return None, None
    svid = active.get("splitViewId")
    if svid is None or svid == -1:
        return None, None
    active_id = active.get("id")
    partner = next((t for t in tabs
                    if t.get("splitViewId") == svid and t.get("id") != active_id), None)
    if partner is None:
        return None, None
    return active_id, partner.get("id")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("=I", raw)[0]
    return sys.stdin.buffer.read(length)


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    header = struct.pack("=I", len(data))
    with write_lock:
        sys.stdout.buffer.write(header + data)
        sys.stdout.buffer.flush()


def send_and_wait(msg, timeout=5):
    msg_id = str(uuid.uuid4())
    msg["id"] = msg_id
    event = threading.Event()
    with pending_lock:
        pending[msg_id] = {"event": event, "result": None}
    send_message(msg)
    if event.wait(timeout=timeout):
        with pending_lock:
            return pending.pop(msg_id)["result"]
    with pending_lock:
        pending.pop(msg_id, None)
    return None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/tabs":
            if self._is_null_origin():
                active_id, partner_id = _focused_split_pair()
                if active_id is None:
                    self._json_response(200, json.dumps({"error": NO_SPLIT_TABS}))
                    return
                active, tabs = _cached_tabs()
                req_url = self.headers.get("X-Tab-Url") or ""
                split_urls = {t.get("url") for t in tabs if t.get("id") in (active_id, partner_id)}
                if not (req_url.startswith("file://") and req_url in split_urls):
                    self._json_response(403, json.dumps({"error": NOT_ALLOWED}))
                    return
                split_tabs = [t for t in tabs if t.get("id") in (active_id, partner_id)]
                narrowed_data = json.dumps({
                    "type": "tabs",
                    "activeTab": active,
                    "tabs": split_tabs
                })
                self._json_response(200, narrowed_data)
                return
            with lock:
                data = state["data"]
            self._json_response(200, data)
        elif self.path == "/groups":
            result = send_and_wait({"type": "groups"})
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        elif self.path == "/containers":
            result = send_and_wait({"type": "containers"})
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        elif self.path == "/active":
            result = send_and_wait({"type": "extract"}, timeout=30)
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        else:
            self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/open":
            url = body.get("url")
            group_name = body.get("groupName")
            cookie_store_id = body.get("cookieStoreId")
            if not url or not group_name:
                self._json_response(400, json.dumps({"error": "url and groupName required"}))
                return
            msg = {"type": "open", "url": url, "groupName": group_name}
            if cookie_store_id:
                msg["cookieStoreId"] = cookie_store_id
            result = send_and_wait(msg)
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        elif self.path == "/group":
            tab_url = body.get("tabUrl")
            group_name = body.get("groupName")
            if not tab_url or not group_name:
                self._json_response(400, json.dumps({"error": "tabUrl and groupName required"}))
                return
            result = send_and_wait({"type": "group", "tabUrl": tab_url, "groupName": group_name})
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        elif self.path == "/eval":
            code = body.get("code")
            if not code:
                self._json_response(400, json.dumps({"error": "code required"}))
                return
            msg = {"type": "eval", "code": code}
            for k in ("url", "tabId"):
                if body.get(k) is not None:
                    msg[k] = body[k]
            result = send_and_wait(msg, timeout=45)
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        elif self.path == "/navigate":
            url = body.get("url")
            if not url:
                self._json_response(400, json.dumps({"error": "url required"}))
                return
            if self._is_null_origin():
                # file:// pages may only redirect the focused tab's split partner.
                active_id, partner_id = _focused_split_pair()
                if active_id is None:
                    self._json_response(200, json.dumps({"error": NO_SPLIT_TABS}))
                    return
                active, tabs = _cached_tabs()
                if not (active and active.get("url", "").startswith("file://")):
                    self._json_response(403, json.dumps({"error": NOT_ALLOWED}))
                    return
                if self.headers.get("X-Tab-Url") != active.get("url"):
                    self._json_response(403, json.dumps({"error": NOT_ALLOWED}))
                    return
                requested = body.get("tabId")
                if requested != partner_id or body.get("newTab"):
                    self._json_response(403, json.dumps({"error": NOT_ALLOWED}))
                    return
            msg = {"type": "navigate", "url": url}
            for k in ("tabId", "newTab", "cookieStoreId", "timeoutMs"):
                if body.get(k) is not None:
                    msg[k] = body[k]
            result = send_and_wait(msg, timeout=60)
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        elif self.path == "/extract":
            msg = {"type": "extract"}
            for k in ("url", "tabId"):
                if body.get(k) is not None:
                    msg[k] = body[k]
            result = send_and_wait(msg, timeout=30)
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        elif self.path == "/close":
            if "expectHost" not in body:
                self._json_response(400, json.dumps({"error": "expectHost required (safety)"}))
                return
            if "expectGroup" not in body:
                self._json_response(400, json.dumps({"error": "expectGroup required (name, null for ungrouped, or \"*\" to skip)"}))
                return
            # Need a selector: tabId/url, OR a concrete expectGroup (name) that selects the whole group.
            has_selector = body.get("url") is not None or body.get("tabId") is not None
            group_selects = body.get("expectGroup") not in (None, "", "*")
            if not has_selector and not group_selects:
                self._json_response(400, json.dumps({"error": "provide url/tabId, or a concrete expectGroup to close a whole group"}))
                return
            msg = {"type": "close"}
            # note: expectGroup/url/tabId may legitimately be null → copy by key presence
            for k in ("url", "tabId", "prefix", "expectHost", "expectGroup"):
                if k in body:
                    msg[k] = body[k]
            result = send_and_wait(msg)
            if result:
                self._json_response(200, json.dumps(result))
            else:
                self._json_response(504, json.dumps({"error": "timeout"}))
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        # Preflight: reflect the allowed origin (if any) so the browser lets the
        # real request through. A disallowed cross-origin call is blocked here.
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _json_response(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data.encode() if isinstance(data, str) else data)

    def _is_null_origin(self):
        """True only for the file:// (`Origin: null`) case this extra narrowing targets.
        Localhost origins and no-Origin (curl/agentic) callers are never true here, so
        they reach /tabs and /navigate exactly as before."""
        return self.headers.get("Origin") == "null"

    def _allowed_origin(self):
        """Return the Origin value to echo in Access-Control-Allow-Origin, or None
        if this origin isn't allowed to reach this path.

        - No Origin header (curl / same-process tools): unrestricted — return None
          and the caller emits no ACAO header (CORS is irrelevant without an Origin).
        - localhost/127.0.0.1 origins: allowed on every endpoint.
        - file:// pages (sent as `Origin: null`): allowed only on FILE_OK_PATHS.
        - anything else: denied.
        """
        origin = self.headers.get("Origin")
        if origin is None:
            return None  # non-browser client; no CORS restriction applies
        path = self.path.split("?", 1)[0]
        if _LOCALHOST_ORIGIN_RE.match(origin):
            return origin
        if origin == "null" and path in FILE_OK_PATHS:
            return "null"
        return False  # explicitly disallowed

    def _cors_headers(self):
        allowed = self._allowed_origin()
        if allowed is None:
            # No Origin header — non-browser caller; skip CORS headers entirely.
            return
        if allowed is False:
            # Disallowed browser origin: emit no ACAO so the browser blocks the read.
            return
        self.send_header("Access-Control-Allow-Origin", allowed)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Tab-Url")

    def log_message(self, *_):
        pass


def run_server(httpd):
    httpd.serve_forever()


def keepalive_pinger():
    """Ping the extension every 20s. Receiving a native message resets the MV3 service
    worker's idle timer, keeping it alive so live commands (/groups, /extract) don't
    time out while the worker is dormant. The SW ignores type=="ping"."""
    import time
    while True:
        time.sleep(20)
        try:
            send_message({"type": "ping"})
        except Exception:
            break


def _pids_on_port(port):
    """Return PIDs (excluding ourselves) holding a LISTEN socket on `port`, via /proc."""
    import os, glob
    want_inodes = set()
    for tcp in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(tcp) as f:
                next(f)
                for line in f:
                    p = line.split()
                    if p[3] != "0A":  # 0A == LISTEN
                        continue
                    if int(p[1].rsplit(":", 1)[1], 16) == port:
                        want_inodes.add(p[9])  # socket inode
        except Exception:
            pass
    pids = []
    if not want_inodes:
        return pids
    me = os.getpid()
    for fd_link in glob.glob("/proc/[0-9]*/fd/*"):
        try:
            tgt = os.readlink(fd_link)
        except OSError:
            continue
        if tgt.startswith("socket:["):
            inode = tgt[len("socket:["):-1]
            if inode in want_inodes:
                pid = int(fd_link.split("/")[2])
                if pid != me:
                    pids.append(pid)
    return pids


def _bind_newest_wins():
    """Bind PORT. If a stale host owns it, kill that host and retry (newest host wins,
    because it is the one connected to the currently-live MV3 service worker)."""
    import os, signal, time
    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True
    for _ in range(10):
        try:
            return ReusableHTTPServer(("127.0.0.1", PORT), Handler)
        except OSError:
            for pid in _pids_on_port(PORT):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
            time.sleep(0.3)
    return None


if __name__ == "__main__":
    # Newest-wins singleton: the live service worker just spawned us, so we should own
    # the port. If a stale host (whose SW has died) holds it, take it over. The live SW's
    # open native-messaging port then keeps that SW alive so live commands don't time out.
    httpd = _bind_newest_wins()
    if httpd is None:
        sys.exit(0)

    threading.Thread(target=run_server, args=(httpd,), daemon=True).start()
    threading.Thread(target=keepalive_pinger, daemon=True).start()

    while True:
        msg = read_message()
        if msg is None:
            break
        data = json.loads(msg.decode("utf-8"))

        if data.get("type") == "result":
            msg_id = data.get("id")
            with pending_lock:
                if msg_id in pending:
                    pending[msg_id]["result"] = data
                    pending[msg_id]["event"].set()
        elif data.get("type") == "tabs":
            with lock:
                state["data"] = json.dumps({
                    "activeTab": data.get("activeTab"),
                    "tabs": data.get("tabs", []),
                })
        else:
            # Legacy: raw tab data without type field
            with lock:
                state["data"] = msg.decode("utf-8")
