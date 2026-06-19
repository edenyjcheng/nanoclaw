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
import re
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

CONVERSATIONS_DIR = Path(
    os.getenv("CONVERSATIONS_DIR", "/workspace/group/conversations")
)
PILOT_COUNT = 10
# Safety cap: any single file producing more chunks than this is skipped during
# pilot to avoid swamping Graphiti with thousands of LLM-extraction jobs from
# one outlier conversation. See WO-20260429-003 response for rationale.
PILOT_MAX_CHUNKS_PER_FILE = 100

# WO-20260429-007: summarize-then-ingest for conversations/.
# Per-file summarization avoids the per-turn-chunk explosion (~1400 chunks for
# long sessions) revealed by the WO-003 pilot.
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://host.docker.internal:11434/api/generate")
OLLAMA_CONFIG_PATH = Path(
    os.getenv(
        "OLLAMA_CONFIG_PATH", "/workspace/group/memory/ollama-config.json"
    )
)
CONV_SUMMARY_MAX_INPUT_CHARS = 8000   # reduced from 12000 to cut GPU time per call
CONV_SUMMARY_NUM_PREDICT = 800
CONV_SUMMARY_TEMPERATURE = 0.2
CONV_SUMMARY_TIMEOUT_S = 300          # fallback; overridden by ollama-config.json timeouts.kb_ingest

TARGETS = [
    "/workspace/group/docs/work-orders",
    "/workspace/group/docs/proposals",
    "/workspace/group/docs/guides",
    "/workspace/group/ipc-claudecode",
    "/workspace/group/memory/session-log.md",
    "/workspace/group/memory/decision-log.md",
    "/workspace/group/CLAUDE.md",

    # --- KB Stage 1b WO-002: memory/ group (2026-04-29) ---
    "/workspace/group/memory/analyst-jobs.md",
    "/workspace/group/memory/analyst-workstyle.md",
    "/workspace/group/memory/cortana-hot.md",
    "/workspace/group/memory/cortana-personality.md",
    "/workspace/group/memory/critical-path.md",
    "/workspace/group/memory/index.md",
    "/workspace/group/memory/kendo-schedule.md",
    "/workspace/group/memory/shared-context.md",
    "/workspace/group/memory/todo-list.md",
    "/workspace/group/memory/yung-profile.md",
    "/workspace/group/memory/Work/work-context.md",
    "/workspace/group/memory/Work/work-profile.md",
    "/workspace/group/memory/Work/work-todo-list.md",
    "/workspace/group/memory/Work/docs/python-certification.md",
    "/workspace/group/memory/agents/calendar-keeper.md",
    "/workspace/group/memory/agents/dashboard-updater.md",
    "/workspace/group/memory/agents/learning-log.md",
    "/workspace/group/memory/agents/mem0-agent.md",
    "/workspace/group/memory/agents/pending-event-keeper.md",
    "/workspace/group/memory/agents/researcher-capabilities.md",
    "/workspace/group/memory/agents/researcher-performance.md",
    "/workspace/group/memory/agents/researcher-popularity.md",
    "/workspace/group/memory/agents/shared-context.md",
    "/workspace/group/memory/agents/system-health-agent.md",
    "/workspace/group/memory/agents/team-template.md",
    "/workspace/group/memory/reports/ollama-vs-claude-report-20260408.md",
    "/workspace/group/memory/reports/report-ollama-usage.md",
    "/workspace/group/memory/tools/inbox-pipeline/learning-log.md",
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


def chunk_conversation(path: Path) -> list[tuple[str, str]]:
    """Split a conversation file into (episode_name, episode_body) chunks by speaker turn.

    See WO-20260429-003. Two regex fixes vs the IPC reference snippet:
      - context-tag strip uses [^>]* (not [^/]*) so URLs like .../America/New_York
        don't break the match.
      - speaker-boundary split uses (?:User|Cortana) (non-capturing) so re.split
        doesn't interleave speaker labels into the chunk list.
    """
    content = path.read_text(encoding="utf-8", errors="replace")

    content = re.sub(r'<context\b[^>]*/>', '', content)
    content = re.sub(r'<messages>.*?</messages>', '', content, flags=re.DOTALL)
    content = re.sub(r'<message\b[^>]*>.*?</message>', '', content, flags=re.DOTALL)

    turns = re.split(r'\n(?=\*\*(?:User|Cortana)\*\*:)', content)

    m = re.match(r'(\d{4}-\d{2}-\d{2})-conversation-(\d+)', path.stem)
    file_key = f"{m.group(1)}-{m.group(2)}" if m else path.stem

    chunks: list[tuple[str, str]] = []
    for i, turn in enumerate(turns):
        turn = turn.strip()
        if not turn or len(turn) < 20:
            continue
        if len(turn) > 2000:
            paragraphs = turn.split('\n\n')
            buf, sub = "", 0
            for para in paragraphs:
                if len(buf) + len(para) > 2000 and buf:
                    name = f"conv:{file_key}:turn-{i:04d}-{sub:02d}"
                    body = f"Source: {path}:turn-{i}-{sub}\n\n{buf.strip()}"
                    chunks.append((name, body))
                    buf, sub = "", sub + 1
                buf += para + "\n\n"
            if buf.strip():
                name = f"conv:{file_key}:turn-{i:04d}-{sub:02d}"
                body = f"Source: {path}:turn-{i}-{sub}\n\n{buf.strip()}"
                chunks.append((name, body))
        else:
            name = f"conv:{file_key}:turn-{i:04d}"
            body = f"Source: {path}:turn-{i}\n\n{turn}"
            chunks.append((name, body))
    return chunks


def ingest_conversations_pilot(graphiti_url: str) -> dict:
    """Pilot: ingest PILOT_COUNT most recent conversation files with chunking.

    Does NOT touch the manifest — pilot episodes are evaluation data, not
    part of the steady-state ingest record.
    """
    files = sorted(CONVERSATIONS_DIR.glob("*.md"), reverse=True)[:PILOT_COUNT]
    total_files = total_chunks = ok_count = fail_count = 0
    sample_names: list[str] = []
    per_file: list[dict] = []
    skipped_oversized: list[dict] = []

    for path in files:
        chunks = chunk_conversation(path)
        total_files += 1
        per_file.append({"file": path.name, "chunks": len(chunks)})

        if len(chunks) > PILOT_MAX_CHUNKS_PER_FILE:
            skipped_oversized.append({"file": path.name, "chunks": len(chunks)})
            continue

        for name, body in chunks:
            total_chunks += 1
            if len(sample_names) < 5:
                sample_names.append(name)
            ok = add_memory(graphiti_url, name, body, f"conv-pilot:{path.name}")
            if ok:
                ok_count += 1
            else:
                fail_count += 1

    pushed_files = total_files - len(skipped_oversized)
    return {
        "files_processed": total_files,
        "files_pushed": pushed_files,
        "files_skipped_oversized": skipped_oversized,
        "max_chunks_per_file_cap": PILOT_MAX_CHUNKS_PER_FILE,
        "total_chunks_pushed": total_chunks,
        "ok": ok_count,
        "failed": fail_count,
        "avg_chunks_per_pushed_file": round(total_chunks / pushed_files, 2) if pushed_files else 0,
        "per_file_chunk_counts": per_file,
        "sample_episode_names": sample_names,
    }


def load_conv_model() -> str:
    """Read the model for KB ingest summarization from ollama-config.json.

    Priority: job_models.kb_ingest > models.reason > hardcoded fallback.
    Using a dedicated job model (gemma3:12b) avoids the qwen3:14b timeout
    problem — qwen3 emits think-blocks and is too slow for 8k-char inputs
    at the 300s ceiling.
    """
    try:
        with open(OLLAMA_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        job_model = cfg.get("job_models", {}).get("kb_ingest")
        if job_model:
            return job_model
        return cfg.get("models", {}).get("reason", "gemma3:12b")
    except (OSError, json.JSONDecodeError) as e:
        log.warning(f"Could not read {OLLAMA_CONFIG_PATH}, defaulting to gemma3:12b: {e}")
        return "gemma3:12b"


def load_conv_timeout() -> int:
    """Read the summarization timeout from ollama-config.json timeouts.kb_ingest.
    Falls back to CONV_SUMMARY_TIMEOUT_S (module-level default) on any error."""
    try:
        with open(OLLAMA_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return int(cfg.get("timeouts", {}).get("kb_ingest", CONV_SUMMARY_TIMEOUT_S))
    except (OSError, json.JSONDecodeError, ValueError) as e:
        log.warning(f"Could not read kb_ingest timeout from {OLLAMA_CONFIG_PATH}: {e}")
        return CONV_SUMMARY_TIMEOUT_S


def strip_conv_boilerplate(text: str) -> str:
    """Centralized cleaner for the XML envelope that Telegram/NanoClaw inserts
    into conversation logs. Mirrors the patterns in chunk_conversation() but is
    safe to call on raw file text (does not assume turn boundaries)."""
    text = re.sub(r'<context\b[^>]*/>', '', text)
    text = re.sub(r'<messages>|</messages>', '', text)
    text = re.sub(r'<message\b[^>]*>|</message>', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


_CONV_SUMMARY_PROMPT = (
    "You are a summarizer for a personal AI assistant's conversation log. "
    "Read the conversation below and produce a structured summary in plain text. "
    "Extract ONLY what is present — do not invent. Include:\n"
    "- KEY DECISIONS: Any explicit decisions made (look for 'decided', 'going with', "
    "'final decision', WO creation)\n"
    "- TASKS COMPLETED: Anything marked done or verified\n"
    "- WOs MENTIONED: WO IDs referenced or created (format: WO-YYYYMMDD-NNN)\n"
    "- CORRECTIONS/LESSONS: Any 'next time', 'remember', 'don't do', behaviour corrections\n"
    "- MAIN TOPICS: 3-5 bullet points on what was discussed\n"
    "- OPEN THREADS: Anything explicitly left pending or deferred\n"
    "Keep each section under 5 bullets. If a section has nothing, write 'None'.\n\n"
    "CONVERSATION:\n"
)


def summarize_via_ollama(content: str, model: str, timeout: int = CONV_SUMMARY_TIMEOUT_S) -> str:
    """Send `content` to Ollama /api/generate and return the response text.
    On error returns a string starting with `[summarization failed` so the
    caller can detect failure without exception handling."""
    prompt = _CONV_SUMMARY_PROMPT + content[:CONV_SUMMARY_MAX_INPUT_CHARS]
    try:
        resp = requests.post(
            OLLAMA_URL,
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "think": False,
                "options": {
                    "temperature": CONV_SUMMARY_TEMPERATURE,
                    "num_predict": CONV_SUMMARY_NUM_PREDICT,
                },
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, ValueError) as e:
        return f"[summarization failed: {e}]"

    text = (data.get("response") or "").strip()
    if not text:
        # Defensive fallback: thinking models (gemma4, qwen3) with native Ollama
        # thinking support put reasoning in 'thinking' field, leaving 'response'
        # empty. The 'think: false' call option above should prevent this, but
        # log it as a warning if it still occurs so it's visible in kb-ingest.log.
        thinking = (data.get("thinking") or "").strip()
        if thinking:
            log.warning(
                f"summarize_via_ollama: 'response' empty but 'thinking' populated "
                f"({len(thinking)} chars). Model={model}. Consider 'think:false' or a "
                f"non-thinking model for kb_ingest."
            )
        return "[summarization failed: empty response]"
    # qwen3 emits <think>...</think> reasoning blocks before the actual answer.
    # Strip those so the episode body is just the structured summary.
    text = re.sub(r'<think\b[^>]*>.*?</think>', '', text, flags=re.DOTALL).strip()
    if not text:
        return "[summarization failed: only think-block, no answer]"
    return text


def ingest_conversations_summarized(manifest: dict) -> dict:
    """Per-file summarize-then-ingest for conversations/. One Graphiti episode
    per source file. Manifest key `conv-summary:<stem>` gates re-ingestion.

    Mutates `manifest` in place — caller is responsible for saving.
    """
    model = load_conv_model()
    timeout = load_conv_timeout()
    log.info(f"conv-summarize: model={model} timeout={timeout}s max_input={CONV_SUMMARY_MAX_INPUT_CHARS}")
    conv_files = sorted(CONVERSATIONS_DIR.glob("*.md"), reverse=True)

    report = {
        "files_found": len(conv_files),
        "files_skipped_already_ingested": 0,
        "files_processed": 0,
        "files_pushed": 0,
        "files_failed": 0,
        "model_used": model,
        "conversations_dir": str(CONVERSATIONS_DIR),
    }

    for path in conv_files:
        manifest_key = f"conv-summary:{path.stem}"
        if manifest_key in manifest:
            report["files_skipped_already_ingested"] += 1
            continue

        report["files_processed"] += 1

        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            log.error(f"Read failed for {path}: {e}")
            report["files_failed"] += 1
            continue
        cleaned = strip_conv_boilerplate(raw)

        summary = summarize_via_ollama(cleaned, model, timeout)
        if summary.startswith("[summarization failed"):
            log.warning(f"summarize failed for {path.name}: {summary}")
            report["files_failed"] += 1
            continue

        path_str = str(path)
        episode_body = (
            f"Source: {path_str}\n\n"
            f"Conversation Summary — {path.stem}\n\n"
            f"{summary}"
        )
        name = f"conv-summary:{path.stem}"
        source_description = f"conv-summary:{path.name}"

        ok = add_memory(GRAPHITI_URL, name, episode_body, source_description)
        if ok:
            manifest[manifest_key] = {
                "path": path_str,
                "ingested_at": datetime.now(timezone.utc).isoformat(),
                "type": "conv-summary",
                "model": model,
            }
            # Persist per-file so a mid-run crash doesn't force re-summarizing
            # the entire backlog (each summary is ~30-120s of GPU time).
            try:
                save_manifest_atomic(MANIFEST_PATH, manifest)
            except OSError as e:
                log.error(f"Manifest write failed after {path.name}: {e}")
            report["files_pushed"] += 1
            log.info(f"OK conv-summary: {path.name}")
        else:
            report["files_failed"] += 1
            log.warning(f"FAIL conv-summary: {path.name}")

    return report


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
        # Prefix source path into the indexed body so semantic search results
        # surface the originating file. Manifest hash above still uses raw
        # `content` so unchanged files are correctly skipped.
        episode_body = f"Source: {path_str}\n\n{content}"

        ok = add_memory(GRAPHITI_URL, name, episode_body, source_description)
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
    if "--pilot" in sys.argv:
        report = ingest_conversations_pilot(GRAPHITI_URL)
        print(json.dumps(report, indent=2))
        sys.exit(0)
    if "--conversations" in sys.argv:
        # Per WO-20260429-007: summarize-then-ingest. Distinct from --pilot
        # (which pushes raw turn-chunks) — this produces one episode per file.
        manifest = load_manifest(MANIFEST_PATH)
        report = ingest_conversations_summarized(manifest)
        try:
            save_manifest_atomic(MANIFEST_PATH, manifest)
        except OSError as e:
            log.error(f"Final manifest write failed: {e}")
        print(json.dumps(report, indent=2))
        sys.exit(0 if report["files_failed"] == 0 else 1)
    sys.exit(main())
