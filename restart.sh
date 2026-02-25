#!/bin/bash
cd /home/tiago/llm-fallback-proxy
lsof -i:8000 | grep LISTEN | awk '{print $2}' | xargs -r kill -9
sleep 1
mkdir -p logs
LOG_FILE="$PWD/logs/llm-fallback-proxy.log"
nohup env LLM_FALLBACK_PROXY_LOG_FILE="$LOG_FILE" bun run src/index.ts >> "$LOG_FILE" 2>&1 &
sleep 2
bun run smoke
