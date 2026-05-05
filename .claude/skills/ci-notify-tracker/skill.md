# CI Failure Notification to Tracker

Set up CI/CD pipelines to automatically create Tracker issues when builds fail. Use this skill when adding failure notifications to any CI workflow (Gitea Actions, GitHub Actions).

## The Pattern

Each CI job tees its output to `/tmp/ci-output.txt`, then on failure posts the last ~80 lines of that log to Tracker via the issues API. The notify step is inline within each job (not a separate job) so it has access to the captured output. The implementation uses `jq -n` with `--rawfile` to safely embed log content into JSON — no Python heredocs, no positional `sys.argv` args, no triple-escaped backticks.

## Key Details

- **API URL:** `${TRACKER_API_URL}/api/companies/REDACTED-COMPANY-ID/issues`
- **Auth:** `Bearer ${TRACKER_CI_API_KEY}`
- **Project ID (CommissionWatch):** `REDACTED-PROJECT-ID`
- **Assignee Agent ID:** `REDACTED-AGENT-ID`
- **Status:** `todo`, **Priority:** `critical`
- **Required secrets:** `TRACKER_API_URL`, `TRACKER_CI_API_KEY`
- **Runner deps:** `jq`, `curl`, `tail` (all present on `ai2-daedalus`)

## Workflow Integration

Add `| tee -a /tmp/ci-output.txt` to each build/test step (with `set -o pipefail`), then add the `if: failure()` notify step at the end of each job:

```yaml
- name: Install dependencies
  shell: bash
  run: |
    set -o pipefail
    npm ci 2>&1 | tee -a /tmp/ci-output.txt

- name: Test
  shell: bash
  run: |
    set -o pipefail
    npm test 2>&1 | tee -a /tmp/ci-output.txt

# ── Notify Tracker on failure ─────────────────────────────────────
- name: Notify Tracker of CI failure
  if: failure()
  env:
    TRACKER_API_URL: ${{ secrets.TRACKER_API_URL }}
    TRACKER_CI_API_KEY: ${{ secrets.TRACKER_CI_API_KEY }}
    GH_SHA: ${{ github.sha }}
    GH_REF_NAME: ${{ github.ref_name }}
    GH_RUN_ID: ${{ github.run_id }}
    GH_SERVER_URL: ${{ github.server_url }}
    GH_REPOSITORY: ${{ github.repository }}
    JOB_LABEL: ci ${{ matrix.service }}    # or build-and-push, lint-and-test ${{ matrix.workspace }}, etc.
  run: |
    set +e  # notification must never fail the build
    API_URL="$(printf '%s' "$TRACKER_API_URL" | tr -d '[:space:]')"
    API_KEY="$(printf '%s' "$TRACKER_CI_API_KEY" | tr -d '[:space:]')"

    if [ -z "$API_KEY" ] || [ -z "$API_URL" ]; then
      echo "TRACKER_CI_API_KEY or TRACKER_API_URL not set — skipping failure notification"
      exit 0
    fi

    SHORT_SHA="${GH_SHA:0:7}"
    RUN_URL="${GH_SERVER_URL}/${GH_REPOSITORY}/actions/runs/${GH_RUN_ID}"
    COMMIT_URL="${GH_SERVER_URL}/${GH_REPOSITORY}/commit/${GH_SHA}"

    LOG_FILE="/tmp/ci-output.txt"
    LOG_TAIL_FILE="/tmp/ci-output.tail"
    if [ -f "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" | tail -c 4000 > "$LOG_TAIL_FILE"
    else
      echo "(no captured CI output found at $LOG_FILE)" > "$LOG_TAIL_FILE"
    fi

    PAYLOAD=$(jq -n \
      --arg title "CI Failure: ${JOB_LABEL} @ ${SHORT_SHA}" \
      --arg runUrl "$RUN_URL" \
      --arg commitUrl "$COMMIT_URL" \
      --arg sha "$SHORT_SHA" \
      --arg branch "$GH_REF_NAME" \
      --arg job "$JOB_LABEL" \
      --rawfile logTail "$LOG_TAIL_FILE" \
      '{
        title: $title,
        status: "todo",
        priority: "critical",
        projectId: "REDACTED-PROJECT-ID",
        assigneeAgentId: "REDACTED-AGENT-ID",
        description: ("CI failed on `" + $branch + "` @ " + $sha + " (" + $job + ")\n\nRun: " + $runUrl + "\nCommit: " + $commitUrl + "\n\n--- last log lines ---\n\n```\n" + $logTail + "\n```")
      }') || { echo "WARNING: jq failed — skipping Tracker notification"; exit 0; }

    HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_URL}/api/companies/REDACTED-COMPANY-ID/issues" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD")
    CURL_EXIT=$?
    HTTP_BODY=$(echo "$HTTP_RESPONSE" | head -n -1)
    HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n 1)
    if [ "$CURL_EXIT" -ne 0 ] || [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ] 2>/dev/null; then
      echo "WARNING: Failed to create Tracker failure ticket (curl=$CURL_EXIT, http=$HTTP_CODE, body=$HTTP_BODY)"
    else
      echo "Tracker failure ticket created: HTTP $HTTP_CODE"
    fi
    exit 0
```

## Why This Approach

- **`jq -n` with `--rawfile`** safely embeds arbitrary log content into JSON without escaping bugs — Python heredocs with positional `sys.argv` are fragile and easy to misuse (run URL captured but never inserted into description was a real bug).
- **`set +e` + `exit 0`** ensures a Tracker outage never turns a passing build into a failing one (or vice versa, never doubles a failure).
- **Empty-secret guard** lets the workflow run cleanly in forks / branch builds where the secret isn't injected.
- **`tr -d '[:space:]'`** strips stray whitespace from secrets pasted into the Gitea UI.
- **80-line / 4KB log tail** keeps the issue payload bounded; the run URL covers the rest.
- **`tee -a`** captures all step output to a file while still showing it in CI logs.
- **`set -o pipefail`** ensures piped steps still fail properly.

## Per-Job Customization

| Job type | `JOB_LABEL` | Title prefix |
|----------|-------------|--------------|
| Matrix lint/test | `ci ${{ matrix.service }}` or `lint-and-test ${{ matrix.workspace }}` | `CI Failure` |
| Build & push | `build-and-push` | `Build Failure` |
| Deploy | `deploy` | `Deploy Failure` |

## Setup Checklist

1. Add `TRACKER_API_URL` (e.g. `https://tracker.example.invalid`) and `TRACKER_CI_API_KEY` as Gitea repo secrets
2. Add `| tee -a /tmp/ci-output.txt` with `set -o pipefail` to each build/test step
3. Add the `if: failure()` notify step at the end of each job
4. Set `JOB_LABEL` to identify which job/matrix variant failed (so each Tracker issue is distinct)
