#!/usr/bin/env bash
set -euo pipefail

TRACKER_API_URL="https://tracker.example.invalid"
TRACKER_COMPANY_ID="REDACTED-COMPANY-ID"
TRACKER_PROJECT_ID="REDACTED-PROJECT-ID"
QA_AGENT_ID="REDACTED-AGENT-ID"

if [ -z "${TRACKER_API_KEY:-}" ]; then
  echo "ERROR: TRACKER_API_KEY is not set" >&2
  exit 1
fi

JOB_NAME="${1:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg> [log-file]}"
COMMIT_SHA="${2:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg> [log-file]}"
RUN_URL="${3:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg> [log-file]}"
COMMIT_MSG="${4:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url> <commit-msg> [log-file]}"
LOG_FILE="${5:-}"

SHORT_SHA="${COMMIT_SHA:0:7}"

PAYLOAD_FILE=$(mktemp)
python3 -c "
import json, sys
payload = {
    'title': 'CI FAILURE: ' + sys.argv[1] + ' - ' + sys.argv[2],
    'description': '## CI Failure\n\n**Job:** ' + sys.argv[3] + '\n**Commit:** ' + sys.argv[4] + '\n**Run:** ' + sys.argv[5],
    'priority': 'critical',
    'status': 'todo',
    'projectId': sys.argv[6],
    'assigneeAgentId': sys.argv[7]
}
json.dump(payload, open(sys.argv[8], 'w'))
" "$COMMIT_MSG" "$SHORT_SHA" "$JOB_NAME" "$COMMIT_SHA" "$RUN_URL" "$TRACKER_PROJECT_ID" "$QA_AGENT_ID" "$PAYLOAD_FILE"

echo "Posting CI failure issue to Tracker..."
TMPFILE=$(mktemp)
HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" -X POST \
  "${TRACKER_API_URL}/api/companies/${TRACKER_COMPANY_ID}/issues" \
  -H "Authorization: Bearer ${TRACKER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d @"${PAYLOAD_FILE}")
rm -f "$PAYLOAD_FILE"

echo "HTTP response: ${HTTP_CODE}"
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "ERROR: Tracker API returned HTTP ${HTTP_CODE}" >&2
  cat "$TMPFILE" >&2
  rm -f "$TMPFILE"
  exit 1
fi

ISSUE_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$TMPFILE" 2>/dev/null || true)
rm -f "$TMPFILE"
echo "Tracker issue created successfully"

if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ] && [ -n "$ISSUE_ID" ]; then
  echo "Attaching error log as comment..."
  LOG_CONTENT=$(tail -200 "$LOG_FILE")
  COMMENT_FILE=$(mktemp)
  python3 -c "
import json, sys
body = '## Error Log\n\n\`\`\`\n' + sys.stdin.read() + '\n\`\`\`'
json.dump({'body': body}, open(sys.argv[1], 'w'))
" "$COMMENT_FILE" <<< "$LOG_CONTENT"

  curl -s -o /dev/null -X POST \
    "${TRACKER_API_URL}/api/issues/${ISSUE_ID}/comments" \
    -H "Authorization: Bearer ${TRACKER_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"${COMMENT_FILE}" && echo "Log attached" || echo "Warning: could not attach log"
  rm -f "$COMMENT_FILE"
fi
