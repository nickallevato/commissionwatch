#!/usr/bin/env bash
set -euo pipefail

TRACKER_API_URL="https://tracker.example.invalid"
TRACKER_COMPANY_ID="REDACTED-COMPANY-ID"

: "${TRACKER_API_KEY:?TRACKER_API_KEY is required}"

JOB_NAME="${1:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url>}"
COMMIT_SHA="${2:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url>}"
RUN_URL="${3:?Usage: ci-notify-tracker.sh <job-name> <commit-sha> <run-url>}"

PAYLOAD=$(jq -n \
  --arg title "CI FAILURE: ${JOB_NAME} - ${COMMIT_SHA:0:7}" \
  --arg desc "## CI Failure\n\n**Job:** ${JOB_NAME}\n**Commit:** ${COMMIT_SHA}\n**Run:** [View logs](${RUN_URL})" \
  --arg priority "high" \
  '{title: $title, description: $desc, priority: $priority}')

curl -f -s -X POST \
  "${TRACKER_API_URL}/api/companies/${TRACKER_COMPANY_ID}/issues" \
  -H "Authorization: Bearer ${TRACKER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}"
