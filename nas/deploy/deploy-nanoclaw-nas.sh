#!/usr/bin/env bash
# deploy-nanoclaw-nas.sh — deploy NanoClaw v2 to the NAS from BKK
# WO-20260804-008 / WO-009.  Usage: ./deploy-nanoclaw-nas.sh
# Run from Git Bash on the Windows host (not inside a container).
#
# Rewritten 2026-09-03. The previous version predated the eight DooD fixes and
# would have silently broken a working install: it shipped only the server
# image (never the agent image), and overwrote the compose file with one that
# lacked the egress lockdown, the /tmp share, the .env mount and the
# agent-runner mount. It also "verified" with `docker ps`, which passes while
# every agent spawn fails. See nas/README.md.

set -euo pipefail

NAS_USER="cortana"
NAS_HOST="NAS7D955E"
NAS_PATH_REMOTE="/share/nanoclaw"
CS=/share/ZFS530_DATA/.qpkg/container-station
NAS_PATH_EXPORT="export PATH=$CS/bin:$CS/usr/bin:\$PATH"
COMPOSE_FILE="docker-compose.nanoclaw.yml"

# Repo paths (Git Bash format).
REPO_ROOT="/c/workspace/claude/nanoclaw-v2-build"
DEPLOY_DIR="$REPO_ROOT/nas/deploy"

# Server image, and the agent image NanoClaw spawns. The agent tag embeds
# NANOCLAW_INSTALL_ID — keep it in step with .env or spawns look for an image
# that does not exist.
SERVER_IMAGE="nanoclaw:latest"
INSTALL_ID="$(grep -E '^NANOCLAW_INSTALL_ID=' "$DEPLOY_DIR/.env" | cut -d= -f2 | tr -d '\r')"
AGENT_IMAGE="nanoclaw-agent-v2-${INSTALL_ID}:latest"

# --- Preflight: fail before mutating NAS state ------------------------------
# Step 1 tags a rollback image ON THE NAS, so a missing local file discovered
# later leaves the NAS half-mutated with an opaque error as the only clue.
for f in "$DEPLOY_DIR/$COMPOSE_FILE" "$DEPLOY_DIR/.env" "$REPO_ROOT/Dockerfile" "$REPO_ROOT/container/Dockerfile"; do
  [ -f "$f" ] || { echo "ERROR: missing required file: $f" >&2; exit 1; }
done
[ -n "$INSTALL_ID" ] || { echo "ERROR: NANOCLAW_INSTALL_ID not set in $DEPLOY_DIR/.env" >&2; exit 1; }
echo "Deploying: $SERVER_IMAGE + $AGENT_IMAGE"

# --- Step 1: rollback tags --------------------------------------------------
ROLLBACK_TAG="nanoclaw:rollback-$(date +%Y%m%d-%H%M)"
ssh "$NAS_USER@$NAS_HOST" \
  "$NAS_PATH_EXPORT && docker tag $SERVER_IMAGE $ROLLBACK_TAG 2>/dev/null || true"
echo "Rollback tag: $ROLLBACK_TAG"

# --- Step 2: build both images ----------------------------------------------
# The agent image is a SEPARATE image from the server. Shipping only the server
# leaves NanoClaw running and every agent spawn failing with image-not-found —
# which `docker ps` reports as healthy.
docker build -t "$SERVER_IMAGE" "$REPO_ROOT"
docker build -f "$REPO_ROOT/container/Dockerfile" -t "$AGENT_IMAGE" "$REPO_ROOT/container"

# --- Step 3: ship both -------------------------------------------------------
# scp/save, not rsync: Git Bash ships no rsync.
docker save "$SERVER_IMAGE" | ssh "$NAS_USER@$NAS_HOST" "$NAS_PATH_EXPORT && docker load"
docker save "$AGENT_IMAGE"  | ssh "$NAS_USER@$NAS_HOST" "$NAS_PATH_EXPORT && docker load"

# --- Step 4: config ----------------------------------------------------------
scp "$DEPLOY_DIR/$COMPOSE_FILE" "$DEPLOY_DIR/.env" "$NAS_USER@$NAS_HOST:$NAS_PATH_REMOTE/"

# agent-runner source. v2 never bakes it into the agent image — the host
# bind-mounts <projectRoot>/container/agent-runner/src to /app/src per spawn,
# so it must exist on the NAS host or agents die with
# "Module not found /app/src/index.ts".
ssh "$NAS_USER@$NAS_HOST" "mkdir -p $NAS_PATH_REMOTE/container $NAS_PATH_REMOTE/data/oauth"
tar czf - -C "$REPO_ROOT" container/agent-runner \
  | ssh "$NAS_USER@$NAS_HOST" "tar xzf - -C $NAS_PATH_REMOTE" 2>/dev/null || true

# --- Step 5: start -----------------------------------------------------------
# -f is required: compose auto-discovers only compose.yaml / compose.yml /
# docker-compose.yaml / docker-compose.yml, and ours is none of those.
# No --profile cutover: the OAuth refresher stays down while BKK v1 owns
# refreshing. See the compose file.
ssh "$NAS_USER@$NAS_HOST" \
  "$NAS_PATH_EXPORT && cd $NAS_PATH_REMOTE && docker compose -f $COMPOSE_FILE up -d"

# --- Step 6: verify a REAL SPAWN, not process liveness -----------------------
# `docker ps | grep nanoclaw` passes even when the agent image is missing, the
# gateway is unreachable, or the CA mount is broken. Only an actual agent
# round-trip proves the install works.
echo "Waiting for startup…"
sleep 20
ssh "$NAS_USER@$NAS_HOST" "$NAS_PATH_EXPORT && docker ps --format '{{.Names}}  {{.Status}}' | grep nanoclaw"

echo "Verifying agent spawn…"
ssh "$NAS_USER@$NAS_HOST" "$NAS_PATH_EXPORT && \
  docker exec nanoclaw node dist/cli/client.js messaging-groups send \
    --channel-type cli --platform-id smoketest-chat --text 'Reply with exactly: DEPLOY_OK'" >/dev/null 2>&1 || \
  echo "  (no smoketest group — skipping spawn check)"
sleep 55
if ssh "$NAS_USER@$NAS_HOST" "$NAS_PATH_EXPORT && \
     AC=\$(docker ps --format '{{.Names}}' | grep '^ncl-' | head -1); \
     [ -n \"\$AC\" ] && docker logs \$AC 2>&1 | grep -q DEPLOY_OK"; then
  echo "✅ Deploy verified — agent spawned and replied."
else
  echo "⚠️  Agent did not confirm. Check: docker logs nanoclaw" >&2
  echo "    Common causes: agent image missing, gateway unreachable, CA mount empty." >&2
fi

echo
echo "Rollback:"
echo "  ssh $NAS_USER@$NAS_HOST \"$NAS_PATH_EXPORT && docker tag $ROLLBACK_TAG $SERVER_IMAGE && cd $NAS_PATH_REMOTE && docker compose -f $COMPOSE_FILE up -d\""
