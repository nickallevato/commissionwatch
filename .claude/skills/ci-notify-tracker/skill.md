# CI Failure Notification to Tracker

Set up CI/CD pipelines to automatically create Tracker issues when builds fail. Use this skill when adding failure notifications to any CI workflow (GitHub Actions, Gitea Actions, etc.).

## The Pattern

Use the Tracker public routine trigger endpoint. No auth, no scripts, no dependencies — just a single inline `curl` in the CI workflow. The routine handles ticket creation server-side (project assignment, QA agent assignment, priority, log attachment).

## Endpoint

```
POST https://tracker.example.invalid/api/routine-triggers/public/REDACTED-TRIGGER-TOKEN/fire
```

## Payload

```json
{
  "project": "<project-name>",
  "repo": "<org>/<repo>",
  "ref": "<git-ref>",
  "sha": "<commit-sha>",
  "run_url": "<ci-run-url>"
}
```

## Workflow Integration

Add a job that runs `if: failure()` after the main CI jobs:

```yaml
notify-failure:
  needs: [<main-job-names>]
  if: failure()
  runs-on: ubuntu-latest
  steps:
    - name: Notify Tracker QA on failure
      run: |
        curl -s -X POST \
          "https://tracker.example.invalid/api/routine-triggers/public/REDACTED-TRIGGER-TOKEN/fire" \
          -H "Content-Type: application/json" \
          -d "{\"project\":\"<project-name>\",\"repo\":\"<org>/<repo>\",\"ref\":\"${{ github.ref }}\",\"sha\":\"${{ github.sha }}\",\"run_url\":\"${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\"}"
```

Replace `<project-name>` and `<org>/<repo>` with the actual values (e.g. `commissionwatch`, `your-org/commissionwatch`).

## Why This Approach

Previous iterations used a custom bash script (`scripts/ci-notify-tracker.sh`) that called the Tracker issues API directly. This failed repeatedly due to:

| Pitfall | What happened |
|---|---|
| `jq` dependency | Gitea runner image didn't have it — silent 0s failure |
| `printf` for JSON | Special chars in logs/commit messages broke the payload |
| `python3 json.dump` | Added complexity, still fragile in CI environments |
| `curl -o /dev/stderr 2>&1` | Merged response body into HTTP status code variable |
| Secrets configuration | `TRACKER_API_KEY` needed in each CI platform separately |
| Checkout step | Needed just to access the script file |

The public routine trigger avoids all of these: no auth, no scripts, no checkout, no JSON escaping issues. The routine handles ticket creation server-side with correct project, assignee, priority, and log attachment.

## Setup Checklist

1. Add the `notify-failure` job to each CI workflow (`.github/workflows/` and/or `.gitea/workflows/`)
2. Set `needs` to depend on all jobs that should trigger notification on failure
3. Set `if: failure()`
4. Replace `project` and `repo` in the payload with your values
5. No secrets or additional configuration needed

## Adapting for a New Project

Copy the workflow snippet above and change two values:
- `"project":"<your-project>"` — the Tracker project name
- `"repo":"<org>/<repo>"` — the git repo identifier

Everything else (the trigger URL, GitHub context variables) stays the same.
