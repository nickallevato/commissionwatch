# CI Failure Notification to Tracker

Set up CI/CD pipelines to automatically create Tracker issues when builds fail. Use this skill when adding failure notifications to any CI workflow (GitHub Actions, Gitea Actions, etc.).

## The Pattern

Create a bash script that POSTs to the Tracker issues API on failure. Keep it in `scripts/ci-notify-tracker.sh` (or similar) and call it from the CI workflow.

## Script Requirements

1. **No `jq` dependency** — CI runner images often lack it. Use `printf` for JSON construction.
2. **Hardcode `TRACKER_API_URL` and `TRACKER_COMPANY_ID`** — avoids extra secrets config. Only `TRACKER_API_KEY` should be a secret.
3. **Use `set -euo pipefail`** — fail fast on errors.
4. **Capture HTTP status correctly** — use `curl -s -o "$TMPFILE" -w "%{http_code}"`. Never use `2>&1` with `-o /dev/stderr` — it merges the response body into the status code variable.
5. **Add echo output** — CI logs are the only debugging tool. Print what you're doing and the HTTP response code.
6. **Accept positional args** — job name, commit SHA, run URL.

## Reference Script

```bash
#!/usr/bin/env bash
set -euo pipefail

TRACKER_API_URL="https://tracker.example.invalid"
TRACKER_COMPANY_ID="<company-uuid>"

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
```

## Workflow Integration

Add a job that runs `if: failure()` after the main CI jobs:

```yaml
notify-failure:
  needs: [<main-job-names>]
  if: failure()
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Notify Tracker of CI failure
      run: bash scripts/ci-notify-tracker.sh "<job-description>" "${{ github.sha }}" "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
      env:
        TRACKER_API_KEY: ${{ secrets.TRACKER_API_KEY }}
```

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| Using `jq` for JSON | Runner images may not have it. Use `printf`. |
| `curl -o /dev/stderr 2>&1` | Merges response body into `$HTTP_CODE`. Use a temp file with `-o "$TMPFILE"`. |
| No echo output | 0s silent failures are impossible to debug. Always print status. |
| All values as secrets | Hardcode URL and company ID. Only the API key is sensitive. |
| Missing `actions/checkout` | The notify job needs to checkout the repo to access the script. |
| Gitea vs GitHub workflows | Gitea uses `.gitea/workflows/`, GitHub uses `.github/workflows/`. Update both if the repo runs on both. |

## Setup Checklist

1. Create the notify script in `scripts/`
2. Make it executable (`chmod +x`)
3. Add the `notify-failure` job to each CI workflow
4. Set `TRACKER_API_KEY` as a secret in the CI platform (Gitea Settings → Actions → Secrets, or GitHub repo Settings → Secrets)
5. Test by triggering a deliberate failure
