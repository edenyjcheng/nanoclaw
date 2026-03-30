---
name: ollama-classifier
version: 1.0.0
description: Routes conversational messages to local Ollama and task/tool messages
             to Claude. Self-perfecting — learns from misclassifications automatically.
             Requires Ollama running locally. Degrades gracefully if Ollama is unreachable.
author: Cortana
created: 2026-03-26
branch: skill/ollama-classifier
---

## What it does

Adds a three-layer pre-classifier before every message reaches a Claude container.
Conversational messages are answered by Ollama (free, local). Task messages go
to Claude as normal. Self-improving: after every 5 misclassifications, a learning
agent extracts patterns and updates the keyword list automatically.

## Installation

1. Ensure Ollama is running: ollama serve
2. Ensure deepseek-r1:8b is available: ollama pull deepseek-r1:8b
3. git merge skill/ollama-classifier
4. npm run build (in /workspace/project)
5. Restart NanoClaw

## Configuration (optional env vars)

OLLAMA_CLASSIFY_MODEL   Model for Layer 2 classify (default: gemma3:4b)
CLASSIFIER_DATA_DIR     Override data file location (default: data/classifier/)

## Files created

data/classifier/classifier-keywords.json    TASK keyword list (auto-updated)
data/classifier/reroute-log.json            Misclassification signal log
data/classifier/classifier-learning-log.md  Audit trail of learning runs

## How to tune

- Send IPC command classifier_add_keyword to manually add a keyword
- Edit data/classifier/classifier-keywords.json directly (reloads every 5 min)
- The learning agent updates keywords automatically — no manual tuning required

## Removal

git revert the merge commit. Data files in data/classifier/ are safe to delete.
