#!/usr/bin/env bash
set -euo pipefail

TRACKER_API_URL="https://tracker.example.invalid"
TRACKER_COMPANY_ID="REDACTED-COMPANY-ID"
TRACKER_PROJECT_ID="REDACTED-PROJECT-ID"

if [ -z "${TRACKER_API_KEY:-}" ]; then
  echo "ERROR: TRACKER_API_KEY is not set" >&2
  exit 1
fi

JOB_NAME="${1:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg>}"
COMMIT_SHA="${2:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg>}"
RUN_URL="${3:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg>}"
COMMIT_MSG="${4:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg>}"

SHORT_SHA="${COMMIT_SHA:0:7}"

PAYLOAD=$(printf '{"title":"CI FAILURE: %s - %s","description":"## CI Failure\\n\\n**Job:** %s\\n**Commit:** %s\\n**Run:** [View logs](%s)","priority":"critical","status":"todo","projectId":"%s"}' \
  "$COMMIT_MSG" "$SHORT_SHA" "$JOB_NAME" "$COMMIT_SHA" "$RUN_URL" "$TRACKER_PROJECT_ID")

echo "Posting CI failure issue to Tracker..."
TMPFILE=$(mktemp)
HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" -X POST \
  "${TRACKER_API_URL}/api/companies/${TRACKER_COMPANY_ID}/issues" \
  -H "Authorization: Bearer ${TRACKER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

echo "HTTP response: ${HTTP_CODE}"
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "ERROR: Tracker API returned HTTP ${HTTP_CODE}" >&2
  cat "$TMPFILE" >&2
  rm -f "$TMPFILE"
  exit 1
fi
rm -f "$TMPFILE"
echo "Tracker issue created successfully"
