# NanoClaw v1 → v2 Migration Plan (2026-08-04)

**Situation:** `local/windows11` = v1.2.47 (heavily customized fork). `upstream/main` = v2.1.54 (ground-up rewrite). v1 and v2 are **not mergeable**. The path forward is the official migration (`migrate-v2.sh` → `/migrate-from-v1`), which migrates **data** deterministically, followed by **re-implementing** the code customizations using v2 mechanisms.

**Backup:** tag `backup/pre-upstream-sync-20260804` + branch `backup/windows11-20260804` @ `327f7805`. v1 install keeps running untouched throughout (v2 runs alongside; switchover is a service flip).

## What migrates automatically vs. what must be rebuilt

`migrate-v2.sh` (deterministic) + `/migrate-from-v1` (human-judgment) handle **data**:
- ✅ .env keys, v2 DB seed (agent_groups, messaging_groups, wiring)
- ✅ Group folders (v1 `CLAUDE.md` → v2 `instructions.prepend.md` + `memory/` tree via `/migrate-memory`)
- ✅ Session data + conversation continuity, scheduled tasks, channel auth (incl. Telegram)
- ✅ Container skills copied; container image built
- ❌ **`src/*` and `container/agent-runner/src/*` are explicitly NOT portable** — v2's architecture differs fundamentally. They get stashed to `docs/v1-fork-reference/`; features are re-implemented, not translated.

## Feature-by-feature mapping (verified against v2 code)

| v1 customization | v2 fate | Effort |
|---|---|---|
| **Telegram channel** (native adapter) | Re-install `/add-telegram` (Chat SDK, `@chat-adapter/telegram`). Auth = BotFather token + pairing handshake. Auto-migrated by script. | Low (skill) |
| **credential-proxy** (OAuth proactive refresh, resetAt, api-key fallback) | v2 default = **OneCLI vault** (external; handles creds + refresh opaquely — no host-side refresh loop needed). Alt = `use-native-credential-proxy` skill (.env, supports OAuth token, but **no auto-refresh** — manual `claude setup-token` on 401). | **Decision A** |
| **Gmail/GCal** (Google Workspace MCP in `ipc.ts`) | Re-implement as two sibling skills `/add-gmail-tool` + `/add-gcal-tool` (MCP servers, OneCLI-gated credentials, registered per-group via `ncl groups config add-mcp-server`). v2 deliberately splits Workspace into per-service. | Medium (skills, needs OneCLI) |
| **Ollama per-message routing** (classify each msg → chat/reason/vision/Claude) | **No v2 equivalent.** v2 has per-**group** provider (`/add-ollama-provider`) or Ollama-as-MCP-**tool** (`/add-ollama-tool`). True per-message classifier = **net-new host code** (pre-spawn classifier setting session provider). | **Decision B** — High if rebuilt |
| **Image/vision pipeline** (Telegram photo → Ollama vision) | **No v2 equivalent.** v2 gives a generic attachment→file-on-disk hook (`extractAttachmentFiles` in `session-manager.ts`). Ollama-vision interception = net-new (add in copied `telegram.ts` or channel-agnostic host hook). | Medium–High (net-new) |
| **Token/usage tracking** (daily per-job logging) | **No v2 equivalent** — agent-runner doesn't read `message.usage`. Net-new: capture at `container/agent-runner/src/providers/claude.ts` result event → new ProviderEvent + host log/table. | Medium (net-new) |
| **Scheduled tasks** (task-scheduler, job names, token capture) | v2 **has** scheduling (`src/modules/scheduling/`). Tasks auto-migrated. Post-completion hook = `handleRecurrence` (`recurrence.ts`). Per-job token capture ties to token-tracking above. | Low (exists) + Medium (token capture) |
| **Cortana IPC coordinator + sub-agents** (IPC request/response files, `SendMessage`) | **No v2 equivalent in that form.** v2 = `src/modules/agent-to-agent/` (messages, not files) + SDK `Task`/`Team`/`SendMessage` primitives. The Claude Code ↔ Cortana IPC file workflow does not exist. | **Decision C** — workflow redesign |
| **groups/*/CLAUDE.md** (persona + routing + memory instructions) | Persona → `instructions.prepend.md`; facts → `memory/` OKF tree (via `/migrate-memory`). Routing-instruction parts depend on the net-new classifier (Decision B). | Medium (guided by migrate-memory) |
| **kb-ingest, inbox-pipeline** (`scripts/*`) | Portable as scripts; update hardcoded v1 paths (`/workspace/group/…` → v2 session/group paths). | Low–Medium |
| **Container skills** (google-workspace-reauth, status, notion-mcp, etc.) | Portable — drop into `container/skills/`; auto-mounted with default `skills: 'all'`. | Low |
| **`.claude/skills/*`** (add-* + custom) | Upstream `add-*` re-applied via own apply; custom skills copied as-is. | Low |
| **Windows startup** (.bat/.vbs/.ps1, register-startup) | Portable but v2 service model is install-slug based (`src/install-slug.ts`); rework registration. | Low–Medium |

## Decisions required before executing

- **A — Credentials:** OneCLI (recommended — it *replaces* your OAuth-refresh proxy with a managed vault that refreshes for you; also required for the OneCLI-gated Gmail/GCal skills) vs `use-native-credential-proxy` (closest to your v1 .env approach, but you lose auto-refresh).
- **B — Local models:** Rebuild true per-message Ollama routing as net-new v2 host code (high effort, preserves the money-saving classifier), OR adopt v2's per-group model (e.g. a cheap Ollama-backed chat agent group + a Claude group for tools — much simpler, different UX).
- **C — Cortana coordination:** Rebuild the coordinator/sub-agent pattern on v2's agent-to-agent + Team primitives, OR simplify to a single agent while re-establishing the workflow. The old IPC-file loop is gone regardless.

## Recommended phased execution

1. **Phase 0 — Get v2 running (data only, Claude provider).** User runs `bash migrate-v2.sh` in a terminal (interactive — cannot run from inside Claude Code). Then `/migrate-from-v1`: seed owner, `/migrate-memory`, reconcile container configs, smoke-test a real message. v1 stays paused, revert = one service flip.
2. **Phase 1 — Credentials (Decision A).** `/init-onecli` (recommended) or `/use-native-credential-proxy`. Verify a live message gets credentials.
3. **Phase 2 — Channels + tools (skills).** `/add-telegram` (auto-migrated auth), `/add-gmail-tool`, `/add-gcal-tool`, `/add-ollama-tool`. Re-register MCP servers per group.
4. **Phase 3 — Persona + memory.** Finish `/migrate-memory`; port `instructions.prepend.md`; carry Mem0/Graphiti service calls (they're external, not blocked by v2).
5. **Phase 4 — Net-new re-implementations (by priority).** Token tracking → vision pipeline → per-message routing (Decision B) → coordinator (Decision C). Each is custom v2 code; stash v1 originals to `docs/v1-fork-reference/` as intent reference.
6. **Phase 5 — Scripts + Windows startup.** Port kb-ingest/inbox-pipeline with path fixes; rework service registration.

## Constraints & notes

- `migrate-v2.sh` is **interactive terminal-only** — the user runs it; Claude Code cannot. `/migrate-from-v1` picks up after via `logs/setup-migration/handoff.json`.
- Verified v1 feature catalog (must-preserve, checked 2026-08-04): see `docs/sync-plan-upstream-20260804.md` (WO-20260803-001 verification table).
- Rollback at any point: keep v1 service; `git reset --hard backup/pre-upstream-sync-20260804`.
