#!/usr/bin/env bash
set -euo pipefail

TRACKER_API_URL="https://tracker.example.invalid"
TRACKER_COMPANY_ID="REDACTED-COMPANY-ID"

if [ -z "${TRACKER_API_KEY:-}" ]; then
  echo "ERROR: TRACKER_API_KEY is not set" >&2
  exit 1
fi

JOB_NAME="${1:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url>}"
COMMIT_SHA="${2:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url>}"
RUN_URL="${3:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url>}"

SHORT_SHA="${COMMIT_SHA:0:7}"

PAYLOAD=$(printf '{"title":"CI FAILURE: %s - %s","description":"## CI Failure\\n\\n**Job:** %s\\n**Commit:** %s\\n**Run:** [View logs](%s)","priority":"high"}' \
  "$JOB_NAME" "$SHORT_SHA" "$JOB_NAME" "$COMMIT_SHA" "$RUN_URL")

echo "Posting CI failure issue to Tracker..."
HTTP_CODE=$(curl -s -o /dev/stderr -w "%{http_code}" -X POST \
  "${TRACKER_API_URL}/api/companies/${TRACKER_COMPANY_ID}/issues" \
  -H "Authorization: Bearer ${TRACKER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}" 2>&1)

echo "HTTP response: ${HTTP_CODE}"
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "ERROR: Tracker API returned HTTP ${HTTP_CODE}" >&2
  exit 1
fi
echo "Tracker issue created successfully"
