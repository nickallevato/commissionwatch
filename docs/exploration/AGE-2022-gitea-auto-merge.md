# AGE-2022: Non-Agentic Gitea Auto-Merge Workflows

## Problem

Branch-based work is increasing. Merging PRs manually or via expensive AI agents doesn't scale. We need a lightweight, zero-agent workflow that auto-merges branches when they're ready.

## Gitea's Built-In Capabilities

Gitea already ships everything needed for non-agentic auto-merge:

### 1. Branch Protection Rules

Configure on `main` via **Settings → Branches → Branch Protection**:

| Rule | What it does |
|------|-------------|
| **Required approvals** | Gate merge on N human approvals |
| **Enable status checks** | Require CI jobs (glob patterns matching Actions context names) to pass |
| **Block merge if outdated** | Force head branch to be up-to-date with base before merge |
| **Block merge on rejected reviews** | Prevent merge if any reviewer requested changes |

These rules are enforced across all protocols (HTTP, SSH, API, web editor, and auto-merge).

### 2. Auto-Merge (Schedule Merge)

Gitea has a built-in "auto-merge" feature — available via both the Web UI and API:

- **Web UI**: On a PR page, click the merge dropdown and select "Auto-merge". The PR will merge automatically once all branch protection requirements are satisfied.
- **API**: `POST /repos/{owner}/{repo}/pulls/{index}/merge` with `"Do": "merge"` and `"merge_when_checks_succeed": true` schedules the PR for auto-merge.
- **Cancel**: `DELETE /repos/{owner}/{repo}/pulls/{index}/merge` removes the scheduled auto-merge.

When auto-merge is scheduled, Gitea watches for status check completion and approval thresholds. Once all conditions pass, it merges without any external agent or runner involvement.

### 3. Gitea Actions for CI Status Checks

We already have `.gitea/workflows/deploy.yml` running CI on push to `main`. To gate auto-merge on CI, we need CI to also run on PRs and report status checks:

```yaml
on:
  push:
    branches: [main]
  pull_request:        # <-- add this trigger
    branches: [main]
```

The job names become the status check contexts that branch protection rules match against.

## Recommended Workflow

```
Developer pushes branch → Opens PR → CI runs automatically
                                    → Developer clicks "Auto-merge" (or API call schedules it)
                                    → Branch protection gates:
                                        ✓ CI passes
                                        ✓ Required approvals met
                                        ✓ Branch is up-to-date
                                    → Gitea merges automatically
                                    → deploy.yml triggers on main push → deploys
```

**Zero agents involved.** The merge is handled by Gitea's internal scheduler, not an external process.

## Implementation Steps

### Phase 1: Enable PR-triggered CI (low effort)

Update `.gitea/workflows/deploy.yml` to trigger on `pull_request` events targeting `main`. Only the `ci` job should run on PRs (not build/deploy).

### Phase 2: Configure Branch Protection (admin, no code)

In Gitea admin for the `commissionwatch` repo:

1. Protect the `main` branch
2. Enable "Required status checks" → add the `ci` job context
3. Optionally require 1 approval (for human review gate)
4. Enable "Block merge if PR is outdated"

### Phase 3: Use Auto-Merge

- Developers (or agents creating PRs) click "Auto-merge" after opening a PR
- Or, automate via a one-liner in the PR creation script:

```bash
# After creating PR #42:
curl -X POST "https://gitea.example.invalid/api/v1/repos/your-org/commissionwatch/pulls/42/merge" \
  -H "Authorization: token $GITEA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"Do":"merge","merge_when_checks_succeed":true,"merge_message_field":"auto-merge"}'
```

### Phase 4 (Optional): Auto-Delete Branches

In Gitea repo settings, enable "Auto-delete head branches after merge" to keep the repo clean.

## What This Replaces

| Before | After |
|--------|-------|
| Agent watches PRs and triggers merge | Gitea's built-in auto-merge scheduler |
| Agent checks CI status | Branch protection status check requirement |
| Agent enforces review policy | Branch protection approval rules |
| Agent cleans up branches | Gitea auto-delete setting |

## Cost

- **Agents needed**: 0
- **New infrastructure**: None
- **New runners**: None (existing Gitea Actions runner handles CI)
- **Maintenance**: Minimal — branch protection is declarative config

## Caveats

- Auto-merge requires the PR author (or someone with write access) to explicitly schedule it. It's not "merge everything automatically" — it's "merge this PR as soon as it's ready."
- If you want _every_ PR to auto-merge without manual scheduling, you'd need a small Gitea Action or webhook script to call the auto-merge API on PR open. Still no agent — just a 5-line workflow step.
- Merge conflicts must be resolved manually (or by the branch author) before auto-merge can proceed.

## Sources

- [Gitea Protected Branches Documentation](https://docs.gitea.com/usage/access-control/protected-branches)
- [Gitea Pull Request Documentation](https://docs.gitea.com/next/usage/pull-request)
- [Auto-merge PR #9307 (original implementation)](https://github.com/go-gitea/gitea/pull/9307)
- [Gitea automerge Go package](https://pkg.go.dev/code.gitea.io/gitea/services/automerge)
- [Gitea Actions FAQ](https://docs.gitea.com/usage/actions/faq)
