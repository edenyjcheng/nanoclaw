# NanoClaw Improvement Journey

A running log of every improvement made to this NanoClaw installation — what broke, what was built, and why. Kept as a study reference.

---

## 2026-03-21 — Windows Auto-Start on Reboot

**Problem:** After a system reboot, the NanoClaw process was gone and had to be started manually every time.

**What we did:**
- Created `start-nanoclaw-hidden.vbs` — a silent launcher that runs the node process without a console popup
- Created `start-nanoclaw.bat` — sets the correct PATH for Node and Docker before launching
- Registered the VBS launcher in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (no admin required) so NanoClaw starts automatically at every Windows logon

**Tested by:** killing the node process, re-launching via the VBS launcher, verifying it came back up with a full Telegram bot connection and scheduler loop running.

**Files:** `start-nanoclaw.bat`, `start-nanoclaw-hidden.vbs`, `register-startup.ps1`

---

## 2026-03-21 — Instant Acknowledgment on Every Request

**Problem:** When a user sent a message, the container could take 10–30 seconds to cold-start. During that silence, the user had no feedback — the typing indicator alone wasn't enough.

**Two-layer fix:**

**Host level** (`src/index.ts`) — When a new message arrives and no container is running, NanoClaw immediately sends `"Working on it..."` to the user before the container even starts. This covers the cold-start silence window at the infrastructure level.

**Agent level** (`groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`) — The agent's instructions were rewritten to make acknowledgment mandatory:
- `mcp__nanoclaw__send_message` must be the **first action** before any tool calls or reasoning
- Status updates are required during long tasks ("Found the data, compiling now...")
- Sub-agents must include a status line at the start and end of their output; the main agent relays meaningful progress to the user

**Files:** `src/index.ts`, `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`

---

## 2026-03-21 — Orphaned Container Cleanup Bug (Windows)

**Problem:** When NanoClaw restarted, containers from the previous process were supposed to be killed by `cleanupOrphans()`. They weren't. A skill-creation job ran for 68 minutes in an orphaned container, produced output, but no one was listening — the output was lost because the old process was already dead. The user never received the result.

**Root cause:** `docker ps --format '{{.Names}}'` wraps container names in literal single quotes on Windows/Git Bash, producing `'nanoclaw-telegram-main-...'` (with the quotes). Then `docker stop 'nanoclaw-...'` failed silently because no container matched that quoted name. The `catch {}` block swallowed the error.

**Fix** (`src/container-runtime.ts`):
- Removed the single quotes from the format string: `{{.Names}}` instead of `'{{.Names}}'`
- Added `.replace(/^['"]|['"]$/g, '').trim()` on each parsed name as a safety net for any platform quoting variation

**Lesson:** Always log the actual strings being used in shell commands. The log showed `names: ["'nanoclaw-...'"]` with quotes embedded — that was the tell.

**Files:** `src/container-runtime.ts`

---

## 2026-03-21 — Pre-Warmed Container + Startup Notification

**Problem:** Even with the "Working on it..." ack, the first message after a restart still had a cold-start delay (Docker container spin-up + Claude SDK init, typically 15–40 seconds). The user also had no way to know when NanoClaw was back online after a reboot.

**What we built** (`src/index.ts`):

`startupWarmup()` is called at the end of `main()`, immediately after the queue is ready:
1. Sets a `[STARTUP]` prompt in a `startupWarmupPending` map for the main group's chat JID
2. Calls `queue.enqueueMessageCheck()` immediately
3. `processGroupMessages` detects the pending startup prompt (when no real messages are waiting), runs the agent with the `[STARTUP]` context
4. The agent sends the user a short "back online" notification via `send_message`
5. The container stays alive in idle mode (30-minute idle timeout by default)
6. The **first real user message** gets **piped** to the already-warm container — no cold start, near-instant response

**Agent behavior** (`groups/main/CLAUDE.md`): Added a `[STARTUP]` handler — on seeing this message, the agent sends one short "back online" line then goes idle. Does nothing else until the user replies.

**End-to-end result:**
- Container spawned within ~1 second of NanoClaw startup
- "Back online" notification delivered to Telegram in ~15 seconds
- Subsequent user messages respond in under 2 seconds (piped to warm container)

**Files:** `src/index.ts`, `groups/main/CLAUDE.md`

---

*Add new entries above this line, most recent first.*
