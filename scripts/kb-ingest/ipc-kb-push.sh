#!/bin/bash
# ipc-kb-push.sh — push an IPC lifecycle event (WO + IPC file + status) to
# Graphiti as a KB episode. See WO-20260429-005.
#
# Usage: ipc-kb-push.sh <WO-ID> <IPC-file-path> <status>
#   status: filed | responded | archived
#
# MCP transport matches md-ingest.py: Streamable HTTP with explicit session
# handshake (initialize -> capture mcp-session-id -> notifications/initialized
# -> tools/call). graphiti-mcp v1.26 rejects bare tools/call without a session.

set -euo pipefail

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <WO-ID> <IPC-file-path> <status>" >&2
    echo "  status: filed | responded | archived" >&2
    exit 1
fi

WO_ID="$1"
IPC_FILE="$2"
STATUS="$3"

case "$STATUS" in
    filed|responded|archived) ;;
    *)
        echo "ERROR: status must be one of: filed, responded, archived (got: $STATUS)" >&2
        exit 1
        ;;
esac

if [ ! -f "$IPC_FILE" ]; then
    echo "ERROR: IPC file not found: $IPC_FILE" >&2
    exit 1
fi

export WO_ID IPC_FILE STATUS

python3 - <<'PYEOF'
import json
import os
import sys
from urllib.parse import urlparse

import requests

wo_id = os.environ["WO_ID"]
ipc_file = os.environ["IPC_FILE"]
status = os.environ["STATUS"]
graphiti_url = os.environ.get("GRAPHITI_URL", "http://graphiti-mcp:8000")
group_id = os.environ.get("GROUP_ID", "cortanakb")

try:
    with open(ipc_file, "r", encoding="utf-8", errors="replace") as f:
        excerpt = f.read(800)
except OSError as e:
    print(f"FAIL: cannot read IPC file: {e}", file=sys.stderr)
    sys.exit(1)

name = f"ipc:{wo_id}:{status}"
body = (
    f"Source: {ipc_file}\n"
    f"WO: {wo_id}\n"
    f"Status: {status}\n"
    f"File: {ipc_file}\n\n"
    f"{excerpt}"
)

parsed = urlparse(graphiti_url)
host_header = f"localhost:{parsed.port or 8000}"
base_headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Host": host_header,
}

try:
    init_resp = requests.post(
        f"{graphiti_url}/mcp",
        headers=base_headers,
        timeout=30,
        json={
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "ipc-kb-push", "version": "1.0"},
            },
            "id": 0,
        },
    )
    init_resp.raise_for_status()
    sid = init_resp.headers.get("mcp-session-id")
    if not sid:
        print("FAIL: graphiti-mcp did not return mcp-session-id on initialize", file=sys.stderr)
        sys.exit(1)

    requests.post(
        f"{graphiti_url}/mcp",
        headers={**base_headers, "mcp-session-id": sid},
        timeout=30,
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
    )

    resp = requests.post(
        f"{graphiti_url}/mcp",
        headers={**base_headers, "mcp-session-id": sid},
        timeout=120,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "add_memory",
                "arguments": {
                    "name": name,
                    "episode_body": body,
                    "source": "text",
                    "source_description": f"ipc-kb-push:{ipc_file}",
                    "group_id": group_id,
                },
            },
        },
    )
    resp.raise_for_status()
except requests.RequestException as e:
    print(f"FAIL: {e}", file=sys.stderr)
    sys.exit(1)

result = None
for line in resp.text.splitlines():
    if line.startswith("data: "):
        result = json.loads(line[6:])
        break

if result is None:
    print(f"FAIL: no parseable data line in response: {resp.text[:300]}", file=sys.stderr)
    sys.exit(1)
if "error" in result:
    print(f"FAIL: {result['error']}", file=sys.stderr)
    sys.exit(1)
rr = result.get("result", {})
if rr.get("isError"):
    items = rr.get("content", [])
    err = items[0].get("text", "unknown") if items else "unknown"
    print(f"FAIL: {err}", file=sys.stderr)
    sys.exit(1)

print(f"OK: {name}")
PYEOF
