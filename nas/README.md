# NanoClaw v2 on the QNAP NAS

Everything NAS-specific lives here. `nas/` is deliberately top-level rather than
inside `container/` or `src/`: those are upstream's, so anything added there
becomes a merge surface on every future upstream sync. This directory is ours
alone and will never conflict.

Branch: `local/nas-v2`, from `main` (v2.3.0, `5ab77545`).
Sibling: `local/windows11` is BKK's v1.2.47 install — a different architecture,
not mergeable with this.

```
nas/
  deploy/
    docker-compose.nanoclaw.yml   the stack, with all 9 fixes encoded
    .env.example                  template — the real .env is gitignored
    CLAUDE.main.v2.md             Nano's persona
    deploy-nanoclaw-nas.sh        build + ship + verify
  oauth-refresher/                credential refresher sidecar (cutover only)
```

## Deployment facts

| | |
|---|---|
| NAS | `NAS7D955E` / `192.168.86.40`, QTS 5.2.10, Docker 27.1.2-qnap8, x86_64 |
| Path | `/share/nanoclaw` → `ZFS24_DATA/nanoclaw` (2.1 TB) |
| Images | `nanoclaw:latest` (server), `nanoclaw-agent-v2-cortana-nas:latest` (agent) |
| Vault | OneCLI at `onecli-api:10256`, compose project `onecli` |

**`/share` is a 16 MB tmpfs.** Real storage is the ZFS datasets; QTS exposes
each share as a symlink into that tmpfs. A bare `mkdir /share/foo` therefore
"succeeds" into RAM and is lost on reboot. `/share/nanoclaw` is a proper QTS
shared folder. Any new path here needs one too.

**Container Station is not on `cortana`'s SSH PATH.** Every remote docker
command needs:

```bash
CS=/share/ZFS530_DATA/.qpkg/container-station
export PATH=$CS/bin:$CS/usr/bin:$PATH
```

## The nine defects

All are Docker-out-of-Docker specific — invisible when NanoClaw runs natively
on the Docker host, which is how upstream is developed.

**The dangerous class is #1, #6 and #7:** the container starts, `docker ps`
reports it healthy, and the install is completely non-functional. Any
acceptance check must assert a real agent spawn, never process liveness.

| # | Defect | Fix |
|---|---|---|
| 1 | Agent image never built or shipped — a *different* image from the server, tagged from `sha1(cwd)` | build + ship both; `NANOCLAW_INSTALL_ID` pins the tag |
| 2 | No tzdata in v2's `container/Dockerfile` — agents run UTC | tzdata + `ENV TZ` in v2's own file |
| 3 | Server image lacked the Docker CLI — `container-runtime.ts` shells out to `docker` | installed, pinned 27.1.2 to match the NAS daemon |
| 4 | `ONECLI_API_KEY` missing — 401 on every spawn | in `.env` |
| 5 | `container/agent-runner/src` not on the host — v2 never bakes agent source in, it bind-mounts per spawn | ship it; mount `/share/nanoclaw/container` |
| 6 | Agents spawned on the default bridge — `gateway` unresolvable | `NANOCLAW_EGRESS_LOCKDOWN=true` + `onecli-sandboxes` |
| 7 | CA-cert bind sources resolved on the *host*, where Docker created empty directories | share `/tmp:/tmp` |
| 8 | `.env` passed via `env_file` but not mounted — the Telegram adapter reads the *file* | mount it read-only |
| 9 | 26 shell scripts CRLF under `core.autocrlf` — `dash` rejects `set -eu\r` | `.gitattributes` pins `*.sh` to LF |

## OAuth refresher

The vault holds a **static** Anthropic credential (`valueSource: inline`) that
expires in ~24h. **OneCLI cannot refresh it** — its 60 OAuth apps are
third-party services where OneCLI is the registered client; there is no
Anthropic app, and `secrets create/update` take only a literal `--value`
(verified 2026-09-03). BKK v1 refreshes continuously; nothing on the NAS does.

`oauth-refresher/` ports v1's proven logic (`src/credential-proxy.ts:174-330`):
same endpoint, same public client id, 2h margin, 30-min checks.

**A refresh is an auth call, not inference — it costs nothing.** This sidecar is
what keeps the install on the OAuth subscription instead of needing a
separately-billed API key.

### ⚠️ It ships disabled, on purpose

```yaml
oauth-refresher:
  profiles: ["cutover"]
```

Anthropic **rotates the refresh token on every use**. If BKK v1 and this both
run against the account, each invalidates the other's token and whichever
refreshes second holds a dead credential — breaking Cortana *and* Nano. Exactly
one refresher may live. BKK v1 owns that role today.

Until cutover, manually re-pushing BKK's token is not a shortcut — **it is the
correct behaviour.**

To enable, after BKK v1 is stopped:

```bash
mkdir -p /share/nanoclaw/data/oauth
cat > /share/nanoclaw/data/oauth/oauth-state.json <<'JSON'
{"refreshToken":"<from BKK ~/.claude/.credentials.json>","expiresAt":0}
JSON
chmod 600 /share/nanoclaw/data/oauth/oauth-state.json
docker compose -f docker-compose.nanoclaw.yml --profile cutover up -d
```

`expiresAt: 0` forces an immediate refresh on first tick.

**The refresh token lives in a file, not the vault**, because OneCLI exposes no
way to read a secret value back (no `GET /v1/secrets/:id`; `secrets list` omits
values). A write-only vault cannot be the sidecar's own source of truth. The
file is `0600` and written via write-then-rename so a crash cannot truncate the
only copy — but it is a long-lived credential in plaintext on the NAS, and that
is a real trade-off, not a detail.

## Known-good verification

```bash
# a real spawn, not `docker ps`
docker exec nanoclaw node dist/cli/client.js messaging-groups send \
  --channel-type cli --platform-id smoketest-chat --text 'Reply with exactly: OK'
sleep 55
AC=$(docker ps --format '{{.Names}}' | grep '^ncl-' | head -1)
docker logs "$AC" 2>&1 | tail -3
```

Verified cold on 2026-09-02: all agent containers deleted and `/tmp/*.pem`
wiped, then a full restart — the agent respawned on `onecli-sandboxes`, the SDK
rewrote its own CA, and it replied. No manual steps.
