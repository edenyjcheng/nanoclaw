#!/usr/bin/env bash
# Post-rebase recovery script for local/windows11
# Checks for files that upstream deletes and restores them from pre-rebase ref.
#
# Usage:
#   # Before rebase, save the current SHA:
#   PRE_REBASE_SHA=$(git rev-parse HEAD)
#   git rebase main
#   # ... resolve conflicts ...
#   # After rebase completes:
#   ./scripts/post-rebase-recover.sh "$PRE_REBASE_SHA"

set -euo pipefail

PRE_REBASE_SHA="${1:?Usage: $0 <pre-rebase-sha>}"

# Files that upstream deletes but we need to keep.
# Add new files here as our customizations grow.
CRITICAL_FILES=(
  src/credential-proxy.ts
  src/credential-proxy.test.ts
  src/conversation-queue.ts
  container/agent-runner/src/ollama-mcp-stdio.ts
  src/channels/telegram.ts
  src/channels/telegram.test.ts
)

# Exports that must exist in specific files (file:pattern pairs).
REQUIRED_EXPORTS=(
  "src/config.ts:CREDENTIAL_PROXY_PORT"
  "src/container-runtime.ts:CONTAINER_HOST_GATEWAY"
  "src/credential-proxy.ts:applyCredentialProxyEnv"
)

RECOVERED=0
WARNINGS=0

echo "=== Post-rebase recovery check ==="
echo "Pre-rebase ref: $PRE_REBASE_SHA"
echo ""

# 1. Recover missing files
for f in "${CRITICAL_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f — recovering from $PRE_REBASE_SHA"
    git show "${PRE_REBASE_SHA}:${f}" > "$f" 2>/dev/null || {
      echo "  WARNING: could not recover $f (not in pre-rebase ref either)"
      ((WARNINGS++))
      continue
    }
    git add "$f"
    ((RECOVERED++))
  else
    echo "OK: $f"
  fi
done

echo ""

# 2. Check required exports still exist
for entry in "${REQUIRED_EXPORTS[@]}"; do
  file="${entry%%:*}"
  pattern="${entry#*:}"
  if [ -f "$file" ]; then
    if ! grep -q "$pattern" "$file"; then
      echo "WARNING: $file is missing export '$pattern'"
      ((WARNINGS++))
    else
      echo "OK: $file has $pattern"
    fi
  else
    echo "WARNING: $file does not exist (should have been recovered above)"
    ((WARNINGS++))
  fi
done

echo ""
echo "=== Summary ==="
echo "Files recovered: $RECOVERED"
echo "Warnings: $WARNINGS"

if [ "$RECOVERED" -gt 0 ]; then
  echo ""
  echo "Recovered files have been staged. Run 'npm run build' to verify,"
  echo "then commit: git commit -m 'fix: recover files dropped during rebase'"
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo ""
  echo "⚠ Manual fixes needed for the warnings above."
  exit 1
fi
