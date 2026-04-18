#!/usr/bin/env python3
"""
Markdown ingestion pipeline for Cortana KB — Phase 5.

Walks the configured target list, reads every .md file, and pushes each as one
episode to Graphiti via the MCP Streamable HTTP transport. Incremental: a
manifest at MANIFEST_PATH tracks sha256 + mtime per file; unchanged files are
skipped on subsequent runs.

Replaces the Graphify-based pipeline (graphify-runner.sh + graphify-to-graphiti.py),
which only handled source code extensions and produced "No code files found" on
.md inputs.

Environment:
    GRAPHITI_URL   Graphiti MCP base URL (default: http://graphiti-mcp:8000)
    MANIFEST_PATH  manifest JSON path    (default: /workspace/group/data/kb/kb-ingest-manifest.json)
    LOG_FILE       log path              (default: /workspace/group/logs/kb-ingest.log)
    GROUP_ID       Graphiti group_id     (default: cortanakb)
"""

import hashlib
import json
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

GRAPHITI_URL = os.getenv("GRAPHITI_URL", "http://graphiti-mcp:8000")
MANIFEST_PATH = os.getenv(
    "MANIFEST_PATH", "/workspace/group/data/kb/kb-ingest-manifest.json"
)
LOG_FILE = os.getenv("LOG_FILE", "/workspace/group/logs/kb-ingest.log")
GROUP_ID = os.getenv("GROUP_ID", "cortanakb")

TARGETS = [
    "/workspace/group/docs/work-orders",
    "/workspace/group/docs/proposals",
    "/workspace/group/docs/guides",
    "/workspace/group/ipc-claudecode",
    "/workspace/group/memory/session-log.md",
    "/workspace/group/memory/decision-log.md",
    "/workspace/group/CLAUDE.md",
]

Path(LOG_FILE).parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


_MCP_SESSION_ID: str | None = None


def ensure_mcp_session(graphiti_url: str, host_header: str) -> str:
    """Establish an MCP Streamable HTTP session against graphiti-mcp v1.26.0.

    Protocol: POST initialize -> capture `mcp-session-id` response header ->
    POST `notifications/initialized`. Cached module-level for reuse across calls.
    """
    global _MCP_SESSION_ID
    if _MCP_SESSION_ID is not None:
        return _MCP_SESSION_ID

    base_headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Host": host_header,
    }
    init_resp = requests.post(
        f"{graphiti_url}/mcp",
        json={
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "md-ingest", "version": "1.0"},
            },
            "id": 0,
        },
        timeout=30,
        headers=base_headers,
    )
    init_resp.raise_for_status()
    sid = init_resp.headers.get("mcp-session-id")
    if not sid:
        raise RuntimeError("graphiti-mcp did not return mcp-session-id on initialize")

    requests.post(
        f"{graphiti_url}/mcp",
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        timeout=30,
        headers={**base_headers, "mcp-session-id": sid},
    )
    _MCP_SESSION_ID = sid
    return sid


def add_memory(graphiti_url: str, name: str, content: str, source_description: str) -> bool:
    """Push one episode to Graphiti via MCP add_memory.

    Intentionally omits the `uuid` argument: per graphiti_core/graphiti.py
    add_episode, passing `uuid` triggers EpisodicNode.get_by_uuid(), which
    raises NodeNotFoundError if the uuid does not already exist. That makes
    uuid unsuitable as an upsert key — the manifest (sha256 + mtime) is the
    dedup mechanism here, not uuid.
    """
    parsed = urlparse(graphiti_url)
    host_header = f"localhost:{parsed.port or 8000}"

    try:
        session_id = ensure_mcp_session(graphiti_url, host_header)
    except (requests.exceptions.RequestException, RuntimeError) as e:
        log.error(f"Failed to establish MCP session: {e}")
        return False

    payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
            "name": "add_memory",
            "arguments": {
                "name": name,
                "episode_body": content,
                "source": "text",
                "source_description": source_description,
                "group_id": GROUP_ID,
            },
        },
        "id": 1,
    }

    try:
        resp = requests.post(
            f"{graphiti_url}/mcp",
            json=payload,
            timeout=120,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Host": host_header,
                "mcp-session-id": session_id,
            },
        )
        resp.raise_for_status()

        result = None
        for line in resp.text.splitlines():
            if line.startswith("data: "):
                result = json.loads(line[6:])
                break

        if result is None:
            log.warning(f"Graphiti returned no parseable response for episode '{name}'")
            return False

        if "error" in result:
            log.warning(f"Graphiti returned error for episode '{name}': {result['error']}")
            return False

        rpc_result = result.get("result", {})
        if rpc_result.get("isError"):
            content_items = rpc_result.get("content", [])
            err_text = content_items[0].get("text", "unknown") if content_items else "unknown"
            log.warning(f"Graphiti tool error for episode '{name}': {err_text}")
            return False

        log.info(f"Episode queued: {name}")
        return True
    except requests.exceptions.RequestException as e:
        log.error(f"Failed to add episode '{name}': {e}")
        return False


def load_manifest(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        log.info(f"Manifest not found, starting fresh: {path}")
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            log.warning(f"Manifest is not a JSON object, resetting: {path}")
            return {}
        return data
    except (json.JSONDecodeError, OSError) as e:
        log.warning(f"Failed to read manifest, starting fresh: {e}")
        return {}


def save_manifest_atomic(path: str, manifest: dict) -> None:
    """Write manifest via tempfile + os.replace so a crash can't leave a
    half-written JSON file that would reset ingestion state on next run."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=p.name + ".", suffix=".tmp", dir=str(p.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
        os.replace(tmp_path, p)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def collect_md_files(targets: list[str]) -> list[Path]:
    """Resolve TARGETS (mix of dirs and specific .md files) to a deduped list
    of canonical .md paths. Symlinks are resolved so the same file reached via
    two paths is only ingested once."""
    seen: set[Path] = set()
    out: list[Path] = []
    for raw in targets:
        root = Path(raw)
        if not root.exists():
            log.warning(f"Target not found, skipping: {root}")
            continue
        if root.is_file():
            if root.suffix.lower() == ".md":
                canon = root.resolve()
                if canon not in seen:
                    seen.add(canon)
                    out.append(canon)
            continue
        # Directory: walk recursively for .md files
        for p in sorted(root.rglob("*.md")):
            if not p.is_file():
                continue
            canon = p.resolve()
            if canon not in seen:
                seen.add(canon)
                out.append(canon)
    return out


def read_and_hash(path: Path) -> tuple[str, str]:
    """Read the file once, return (sha256_hex, utf8_content)."""
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8", errors="replace")
    return digest, text


def main() -> int:
    log.info(f"md-ingest start — targets={len(TARGETS)} graphiti={GRAPHITI_URL} group_id={GROUP_ID}")

    manifest = load_manifest(MANIFEST_PATH)
    files = collect_md_files(TARGETS)
    log.info(f"Discovered {len(files)} markdown files across targets")

    skipped = 0
    ingested = 0
    failed = 0

    for path in files:
        path_str = str(path)
        try:
            stat = path.stat()
            mtime = stat.st_mtime
        except OSError as e:
            log.error(f"Stat failed for {path}: {e}")
            failed += 1
            continue

        try:
            digest, content = read_and_hash(path)
        except OSError as e:
            log.error(f"Read failed for {path}: {e}")
            failed += 1
            continue

        if not content.strip():
            log.info(f"Skipping empty file: {path}")
            skipped += 1
            continue

        prior = manifest.get(path_str)
        if (
            prior is not None
            and prior.get("hash") == digest
            and prior.get("mtime") == mtime
        ):
            log.info(f"Skipping unchanged: {path}")
            skipped += 1
            continue

        name = f"md:{path.name}"
        source_description = f"md-ingest:{path_str}"

        ok = add_memory(GRAPHITI_URL, name, content, source_description)
        if not ok:
            failed += 1
            continue

        manifest[path_str] = {
            "mtime": mtime,
            "hash": digest,
            "ingested_at": datetime.now(timezone.utc).isoformat(),
        }
        # Persist per-file so a mid-run crash doesn't force full re-ingest.
        try:
            save_manifest_atomic(MANIFEST_PATH, manifest)
        except OSError as e:
            log.error(f"Manifest write failed after ingesting {path}: {e}")
            # Continue — episode is already queued at Graphiti; next run will
            # re-ingest unless the manifest gets persisted eventually.
        ingested += 1

    log.info(
        f"md-ingest done — ingested={ingested} skipped={skipped} failed={failed}"
    )
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
