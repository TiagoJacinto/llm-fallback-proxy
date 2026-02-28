#!/bin/bash
set -euo pipefail

cd /home/tiago/llm-fallback-proxy
lsof -ti:8000 | xargs -r kill -9 || true
sleep 1
mkdir -p logs
LOG_FILE="$PWD/logs/llm-fallback-proxy.log"
nohup env LLM_FALLBACK_PROXY_LOG_FILE="$LOG_FILE" bun run src/index.ts >> "$LOG_FILE" 2>&1 &
sleep 3

# Smoke check should not kill restart flow; print warning instead.
if ! bun run smoke; then
  echo "WARNING: smoke check failed; inspect $LOG_FILE" >&2
fi
