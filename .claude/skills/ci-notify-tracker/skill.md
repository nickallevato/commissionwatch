# CI Failure Notification to Tracker

Set up CI/CD pipelines to automatically create Tracker issues when builds fail. Use this skill when adding failure notifications to any CI workflow (GitHub Actions, Gitea Actions, etc.).

## The Pattern

Each CI job captures its step output to `/tmp/ci-output.txt` using `tee`, then on failure posts the actual error log content directly to Tracker via the issues API. The notify step is inline within each job (not a separate job) so it has access to the captured output.

## Key Details

- **API Endpoint:** `POST https://tracker.example.invalid/api/companies/REDACTED-COMPANY-ID/issues`
- **Auth:** `Bearer $TRACKER_API_KEY` (stored as CI secret)
- **Project ID:** `REDACTED-PROJECT-ID`
- **Assignee (QA Agent):** `REDACTED-AGENT-ID`
- **Priority:** critical
- **Status:** todo

## Workflow Integration

Add `| tee -a /tmp/ci-output.txt` to each build/test step (with `set -o pipefail`), then add an `if: failure()` step at the end of the job:

```yaml
- name: Install dependencies
  shell: bash
  run: |
    set -o pipefail
    npm ci 2>&1 | tee -a /tmp/ci-output.txt

- name: Lint
  shell: bash
  run: |
    set -o pipefail
    npm run lint 2>&1 | tee -a /tmp/ci-output.txt

- name: Test
  shell: bash
  run: |
    set -o pipefail
    npm test 2>&1 | tee -a /tmp/ci-output.txt

- name: Notify Tracker of CI failure
  if: failure()
  env:
    TRACKER_API_KEY: ${{ secrets.TRACKER_API_KEY }}
  run: |
    COMMIT_MSG=$(git log -1 --format=%s)
    SHORT_SHA=$(echo "${{ github.sha }}" | cut -c1-7)
    PAYLOAD=$(python3 -c "
    import json, sys, os
    error_log = ''
    if os.path.exists('/tmp/ci-output.txt'):
        error_log = open('/tmp/ci-output.txt').read()
        if len(error_log) > 5000:
            error_log = '...(truncated)\n' + error_log[-5000:]
    else:
        error_log = 'No output captured'
    print(json.dumps({
        'title': 'CI FAILURE: ' + sys.argv[1] + ' - ' + sys.argv[2],
        'description': '## CI Failure\n\n**Job:** <job-name>\n**Commit:** ' + sys.argv[3] + '\n\n## Error Log\n\n\`\`\`\n' + error_log + '\n\`\`\`',
        'priority': 'critical',
        'status': 'todo',
        'projectId': 'REDACTED-PROJECT-ID',
        'assigneeAgentId': 'REDACTED-AGENT-ID'
    }))" "$COMMIT_MSG" "$SHORT_SHA" "${{ github.sha }}")
    curl -sS -w "\nHTTP_STATUS:%{http_code}" -X POST \
      "https://tracker.example.invalid/api/companies/REDACTED-COMPANY-ID/issues" \
      -H "Authorization: Bearer ${TRACKER_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD"
```

## Why This Approach

- **Inline notify step** within each job avoids cross-job log fetching (which is unreliable on Gitea)
- **`tee -a`** captures all step output to a file while still showing it in CI logs
- **`set -o pipefail`** ensures steps still fail properly despite the pipe to tee
- **`python3 json.dumps`** safely handles special characters in logs and commit messages
- **5000 char truncation** prevents oversized API payloads
- **No `jq` dependency** — the Gitea runner image doesn't have it

## Setup Checklist

1. Add `TRACKER_API_KEY` as a CI secret
2. Add `| tee -a /tmp/ci-output.txt` with `set -o pipefail` to each build/test step
3. Add the `if: failure()` notify step at the end of each job
4. Replace `<job-name>` in the description template with the actual job name
