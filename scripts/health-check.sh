#!/bin/bash
set -euo pipefail

# ============================================================================
# AI Services Health Check Script
# ============================================================================
# Checks local AI services, attempts recovery, and outputs JSON status.
# Usage: bash scripts/health-check.sh
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$PROJECT_DIR/.health-state"
STATE_FILE="$STATE_DIR/health-status.json"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/health-check.log"

# Ensure directories exist
mkdir -p "$STATE_DIR" "$LOG_DIR"

# Timestamp in ISO 8601 format
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Service definitions: name|port|recovery_type|recovery_command
# recovery_type: systemd, script, docker, skip
SERVICES=(
  "llm-fallback-proxy|8000|script|cd \"$PROJECT_DIR\" && bash restart.sh"
  "ccs-cliproxy|8317|systemd|systemctl --user restart ccs-cliproxy"
  "commitbot|18080|systemd|systemctl --user restart commitbot"
  "free-one-api|3000|docker|auto"
  "claude-code-proxy|8082|skip|"
)

# Associative arrays for results
declare -A SERVICE_STATUS
declare -A SERVICE_RECOVERY_ATTEMPTED
declare -A SERVICE_RECOVERY_RESULT
declare -A SERVICE_RECOVERY_OUTPUT

# Log function (logs to file only, not stdout)
log() {
  echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] $*" >> "$LOG_FILE"
}

# Check if a port is listening
check_port() {
  local port=$1
  ss -tlnp 2>/dev/null | grep -q ":$port " || ss -tlnp 2>/dev/null | grep -q ":::$port "
}

# Find Docker container by port
find_container_by_port() {
  local port=$1
  docker ps --filter "publish=$port" --format "{{.ID}}" 2>/dev/null | head -1
}

# Attempt recovery for a service
attempt_recovery() {
  local name=$1
  local recovery_type=$2
  local recovery_command=$3

  case "$recovery_type" in
    systemd)
      if systemctl --user is-active --quiet "${name}.service"; then
        log "$name: Service is active but port not accessible - restarting"
        eval "$recovery_command" >> "$LOG_FILE" 2>&1
        return $?
      else
        log "$name: Service is not active - starting"
        eval "$recovery_command" >> "$LOG_FILE" 2>&1
        return $?
      fi
      ;;
    script)
      log "$name: Running recovery script"
      eval "$recovery_command" >> "$LOG_FILE" 2>&1
      return $?
      ;;
    docker)
      local container=$(find_container_by_port "${name//free-one-api-/}")
      if [[ -n "$container" ]]; then
        log "$name: Restarting container $container"
        docker restart "$container" >> "$LOG_FILE" 2>&1
        return $?
      else
        log "$name: No container found - cannot recover"
        return 1
      fi
      ;;
    skip)
      log "$name: Recovery skipped (configured as skip)"
      return 1
      ;;
    *)
      log "$name: Unknown recovery type: $recovery_type"
      return 1
      ;;
  esac
}

# Check all services
TOTAL_SERVICES=0
HEALTHY_SERVICES=0
DOWN_SERVICES=0

for service in "${SERVICES[@]}"; do
  IFS='|' read -r name port recovery_type recovery_command <<< "$service"

  TOTAL_SERVICES=$((TOTAL_SERVICES + 1))

  # Check if port is listening
  if check_port "$port"; then
    SERVICE_STATUS[$name]="healthy"
    SERVICE_RECOVERY_ATTEMPTED[$name]="false"
    SERVICE_RECOVERY_RESULT[$name]=""
    SERVICE_RECOVERY_OUTPUT[$name]=""
    HEALTHY_SERVICES=$((HEALTHY_SERVICES + 1))
    log "$name: Port $port is listening - healthy"
  else
    SERVICE_STATUS[$name]="down"
    DOWN_SERVICES=$((DOWN_SERVICES + 1))
    log "$name: Port $port is not listening - DOWN"

    # Attempt recovery
    if [[ "$recovery_type" != "skip" ]]; then
      SERVICE_RECOVERY_ATTEMPTED[$name]="true"

      if attempt_recovery "$name" "$recovery_type" "$recovery_command"; then
        # Wait a moment for service to start
        sleep 3

        # Recheck port
        if check_port "$port"; then
          SERVICE_STATUS[$name]="recovered"
          SERVICE_RECOVERY_RESULT[$name]="success"
          SERVICE_RECOVERY_OUTPUT[$name]="Service recovered successfully"
          HEALTHY_SERVICES=$((HEALTHY_SERVICES + 1))
          DOWN_SERVICES=$((DOWN_SERVICES - 1))
          log "$name: Recovery successful - port $port is now listening"
        else
          SERVICE_RECOVERY_RESULT[$name]="failed"
          SERVICE_RECOVERY_OUTPUT[$name]="Recovery command executed but port still not accessible"
          log "$name: Recovery command executed but port $port still not accessible"
        fi
      else
        SERVICE_RECOVERY_RESULT[$name]="failed"
        SERVICE_RECOVERY_OUTPUT[$name]="Recovery command failed - check logs"
        log "$name: Recovery command failed"
      fi
    else
      SERVICE_RECOVERY_ATTEMPTED[$name]="false"
      SERVICE_RECOVERY_RESULT[$name]=""
      SERVICE_RECOVERY_OUTPUT[$name]="Recovery skipped for this service"
    fi
  fi
done

# Build JSON output
JSON_OUTPUT=$(cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "summary": {
    "total": $TOTAL_SERVICES,
    "healthy": $HEALTHY_SERVICES,
    "down": $DOWN_SERVICES
  },
  "services": [
EOF
)

# Add each service to JSON
first=true
for service in "${SERVICES[@]}"; do
  IFS='|' read -r name port recovery_type recovery_command <<< "$service"

  if [[ "$first" == "true" ]]; then
    first=false
  else
    JSON_OUTPUT+=","
  fi

  status="${SERVICE_STATUS[$name]}"
  recovery_attempted="${SERVICE_RECOVERY_ATTEMPTED[$name]}"
  recovery_result="${SERVICE_RECOVERY_RESULT[$name]}"
  recovery_output="${SERVICE_RECOVERY_OUTPUT[$name]}"

  # Escape JSON strings
  recovery_output_escaped=$(echo "$recovery_output" | sed 's/"/\\"/g' | tr -d '\n')

  JSON_OUTPUT+=$(cat <<EOF

    {
      "name": "$name",
      "port": $port,
      "status": "$status",
      "recovery_attempted": $recovery_attempted,
      "recovery_result": "$recovery_result",
      "recovery_output": "$recovery_output_escaped"
    }
EOF
)
done

JSON_OUTPUT+=$(cat <<EOF

  ]
}
EOF
)

# Write to state file
echo "$JSON_OUTPUT" > "$STATE_FILE"

# Output to stdout (for cron)
echo "$JSON_OUTPUT"

# Log summary
log "Health check complete: $HEALTHY_SERVICES/$TOTAL_SERVICES healthy, $DOWN_SERVICES down"

# Exit with error code if any services are down
if [[ $DOWN_SERVICES -gt 0 ]]; then
  exit 1
fi

exit 0
