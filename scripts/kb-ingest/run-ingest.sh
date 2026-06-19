#!/bin/bash
# KB Ingest runner — calls md-ingest.py (Phase 5: replaces graphify-runner.sh)
# Called by NanoClaw scheduled task (kb_ingest).
#
# Two-pass design (per WO-20260429-007):
#   Pass 1: regular .md ingest across TARGETS (work-orders, proposals, memory, etc.)
#   Pass 2: --conversations — summarize-then-ingest for conversations/.
# Passes are sequential and non-fatal — if pass 1 fails, pass 2 still runs;
# overall exit code reflects whether either pass had failures.
set -uo pipefail

PY=python3
SCRIPT=/workspace/project/scripts/kb-ingest/md-ingest.py

rc1=0
"$PY" "$SCRIPT" || rc1=$?

rc2=0
"$PY" "$SCRIPT" --conversations || rc2=$?

if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ]; then
    echo "kb-ingest finished with errors: targets=$rc1 conversations=$rc2" >&2
    exit 1
fi
exit 0
