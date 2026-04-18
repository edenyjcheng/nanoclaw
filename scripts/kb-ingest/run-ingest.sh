#!/bin/bash
# KB Ingest runner — calls md-ingest.py (Phase 5: replaces graphify-runner.sh)
# Called by NanoClaw scheduled task (WI-5.4)
set -e
python3 /workspace/project/scripts/kb-ingest/md-ingest.py
