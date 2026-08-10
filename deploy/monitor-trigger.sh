#!/usr/bin/env bash
#
# The clock for the external monitor.
#
# ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
#
# `.gitea/workflows/monitor.yml` is built, tested and proven: run 26478 probed
# production green from a `workflow_dispatch`. What it does not have is a
# trigger that fires on its own. **Scheduled workflows do not execute on
# gitea.example.invalid** — measured on 2026-08-10 across all 82 repositories on the
# instance: eight workflows declare a cron schedule and the number of runs ever
# triggered by `schedule` is zero. The instance's cron is off; that is an
# operator change on the Gitea host and not something this repository can make.
#
# So this script is the clock. It POSTs the workflow_dispatch that answers 204,
# and it is meant to be run from cron on an always-on machine.
#
# ── WHY THIS RATHER THAN SOMETHING CLEVERER ─────────────────────────────────
#
# It is the cheapest thing that genuinely fires:
#
#   · `workflow_dispatch` is the only trigger measured to work here. `schedule`
#     has never produced a run on this instance, in any repository.
#   · The trigger needs no access to the site. The probe runs on `dh1`, the one
#     runner proven through the Caddy IP gate; this script only has to reach
#     Gitea. That separation is the point — the clock and the prober fail
#     independently.
#   · It costs nothing and installs nothing: bash and curl, both already
#     present. No account, no vendor, no daemon, no new runtime dependency.
#   · The token is never committed. It is read from the environment, or from
#     ~/.config/commissionwatch/gitea.env, which is where this project's Gitea
#     token already lives and which is not in the repository.
#
# What was considered and rejected: turning the instance's cron back on (not
# ours to make, and out of scope — though it would light up eight workflows at
# once); a Tracker routine, which is the pattern the workflow header names and
# which would still need this same token and this same request, so the script is
# that routine's body either way; and hanging the monitor off `push`, which
# fires here but would mean committing on a timer.
#
# ── THE GAP THIS DOES NOT CLOSE ─────────────────────────────────────────────
#
# **If the clock itself stops, nothing notices.** A cron entry that was never
# installed, a machine that was rebooted and did not come back, a token that
# expired — all of them look exactly like a site that has been healthy for a
# week. That is a dead-man's-switch, it needs a third party outside both this
# repository and Gitea, and every free one is an account and a vendor. It is
# named here rather than left as an unstated assumption.
#
# What is done about it cheaply: this script also reads back the age of the most
# recent monitor run and **fails** when that age is far past the interval it was
# told to expect. That does not detect a stopped clock while it is stopped — it
# reports the gap on the next tick that does run, which turns "we quietly
# stopped watching in March" into "the clock says it missed eleven hours". It is
# a smaller claim than a dead-man's-switch and is not offered as one.
#
# ── USAGE ───────────────────────────────────────────────────────────────────
#
#   deploy/monitor-trigger.sh              # dispatch, then check the run age
#   deploy/monitor-trigger.sh --dry-run    # print what it would send, send nothing
#
# Environment (all optional except the token):
#
#   GITEA_TOKEN              required. Never passed as an argument — argv is
#                            world-readable in /proc on a shared machine.
#   GITEA_URL                default https://gitea.example.invalid
#   GITEA_REPO               default your-org/commissionwatch
#   MONITOR_WORKFLOW         default monitor.yml
#   MONITOR_REF              default main
#   MONITOR_MAX_GAP_MINUTES  default 60. The newest monitor run older than this
#                            fails the tick. Deliberately several times the
#                            15-minute interval: one missed tick is a runner
#                            being busy, and a clock that cries at every one of
#                            those is a clock people stop reading.
#   GITEA_ENV_FILE           default ~/.config/commissionwatch/gitea.env
#
# Exit codes:
#   0  dispatched, and the monitor has run recently enough
#   1  usage or configuration error (no token, bad flag)
#   2  the dispatch itself failed — Gitea unreachable, or not 204
#   3  dispatched, but the newest monitor run is older than the allowed gap
#

set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  "")           ;;
  --dry-run)    DRY_RUN=1 ;;
  # Printed from the header rather than duplicated, so the two cannot drift.
  -h|--help)    sed -n '/^# ── USAGE/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *)            echo "monitor-trigger: unknown argument '$1'" >&2; exit 1 ;;
esac

GITEA_ENV_FILE="${GITEA_ENV_FILE:-$HOME/.config/commissionwatch/gitea.env}"

# The env file is a convenience for the operator's own machine, not a
# requirement, and anything already exported wins over it — so a cron entry can
# supply the token from somewhere else without editing this script.
if [ -z "${GITEA_TOKEN:-}" ] && [ -r "$GITEA_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$GITEA_ENV_FILE"
  set +a
fi

GITEA_URL="${GITEA_URL:-https://gitea.example.invalid}"
GITEA_REPO="${GITEA_REPO:-your-org/commissionwatch}"
MONITOR_WORKFLOW="${MONITOR_WORKFLOW:-monitor.yml}"
MONITOR_REF="${MONITOR_REF:-main}"
MONITOR_MAX_GAP_MINUTES="${MONITOR_MAX_GAP_MINUTES:-60}"

API="${GITEA_URL%/}/api/v1/repos/${GITEA_REPO}"
DISPATCH_URL="${API}/actions/workflows/${MONITOR_WORKFLOW}/dispatches"
# No `limit` — this Gitea ignores it and returns the whole list either way, and
# a parameter that is silently dropped reads in the code as a bound that exists.
RUNS_URL="${API}/actions/runs"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say()   { echo "$(stamp) monitor-trigger: $*"; }

if [ "$DRY_RUN" = "1" ]; then
  say "would POST ${DISPATCH_URL} with {\"ref\":\"${MONITOR_REF}\"}"
  say "would then read ${RUNS_URL} and fail past ${MONITOR_MAX_GAP_MINUTES} minutes"
  # Says whether a token was found, never what it is.
  if [ -n "${GITEA_TOKEN:-}" ]; then say "token: present"; else say "token: MISSING"; fi
  exit 0
fi

if [ -z "${GITEA_TOKEN:-}" ]; then
  say "GITEA_TOKEN is not set and ${GITEA_ENV_FILE} did not supply one"
  say "the token is never committed; see docs/STATUS.md for where it lives"
  exit 1
fi

# ── Dispatch ────────────────────────────────────────────────────────────────
#
# The token is fed to curl through `--config -`, not through `-H`. An argument
# is visible in `ps` and in /proc/<pid>/cmdline to every user on the machine for
# as long as the request takes, and one of the two places this is meant to run
# is a host shared with seven other products. Standard input is not.
#
# `--fail` is deliberately not used: the status code is the diagnosis, and
# curl's exit code alone collapses 401, 404 and 500 into "22".
curl_with_token() {
  # $1 url, $2 = "post" for the dispatch, anything else for a plain GET.
  {
    printf 'url = "%s"\n' "$1"
    printf 'header = "Authorization: token %s"\n' "$GITEA_TOKEN"
    printf 'silent\nshow-error\n'
    if [ "${2:-}" = "post" ]; then
      printf 'request = "POST"\n'
      printf 'header = "Content-Type: application/json"\n'
      printf 'data = "{\\"ref\\":\\"%s\\"}"\n' "$MONITOR_REF"
      printf 'output = "/dev/null"\n'
      printf 'write-out = "%%{http_code}"\n'
    fi
  } | curl --config -
}

HTTP_CODE="$(curl_with_token "$DISPATCH_URL" post)" || {
  say "FAIL the dispatch request could not be made at all (curl exited non-zero)"
  exit 2
}

if [ "$HTTP_CODE" != "204" ]; then
  say "FAIL dispatch answered http=${HTTP_CODE}, expected 204"
  case "$HTTP_CODE" in
    401|403) say "      the token is missing, wrong, or lacks the repository's actions scope" ;;
    404)     say "      ${MONITOR_WORKFLOW} is not registered on ${MONITOR_REF} in ${GITEA_REPO}" ;;
  esac
  exit 2
fi
say "ok dispatched ${MONITOR_WORKFLOW}@${MONITOR_REF} (http=204)"

# ── Read back how long it has been since a monitor run ──────────────────────
#
# The run this dispatch just created is normally the newest one, so on a healthy
# tick this reads back as an age of seconds. It matters on the tick *after* an
# outage of the clock, which is the only moment a stopped clock is visible from
# inside the system it stopped watching.
#
# A check that could not run reports `blocked`, never `pass`.
RUNS_JSON="$(curl_with_token "$RUNS_URL" 2>/dev/null || true)"

# Two things this Gitea does that a quick parser gets wrong:
#
#  · The field is `started_at` and it carries an **offset** —
#    `2026-08-10T00:16:43-06:00`, not a `Z`. Reading the first nineteen
#    characters as UTC makes every run look six hours older than it is, which
#    turns a healthy tick into a failure.
#  · A run that has been created but has not started yet reports
#    `1969-12-31T17:00:00-07:00` — **epoch zero in the instance's local zone**,
#    not null. The run this dispatch just created is normally in exactly that
#    state, so taking the first match blindly reads the clock as fifty-six years
#    behind. Anything at or before epoch zero is "has not started", not a date.
#
# Runs come back newest first, so the first *started* match is the newest.
EPOCH_FLOOR=946684800   # 2000-01-01; below this the stamp is a placeholder

monitor_run_stamps() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$RUNS_JSON" | jq -r --arg wf "$MONITOR_WORKFLOW" '
      .workflow_runs[]
      | select(.path | startswith($wf))
      | .started_at // empty' 2>/dev/null
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    RUNS_JSON="$RUNS_JSON" MONITOR_WORKFLOW="$MONITOR_WORKFLOW" python3 - <<'PY' 2>/dev/null
import json, os
raw = os.environ.get("RUNS_JSON", "")
wf = os.environ.get("MONITOR_WORKFLOW", "")
try:
    runs = json.loads(raw).get("workflow_runs", [])
except Exception:
    raise SystemExit(0)
for run in runs:
    if str(run.get("path", "")).startswith(wf) and run.get("started_at"):
        print(run["started_at"])
PY
    return
  fi
  return
}

to_epoch() {
  if date -u -d "$1" +%s 2>/dev/null; then return; fi
  if command -v python3 >/dev/null 2>&1; then
    STAMP="$1" python3 -c 'import os,datetime;print(int(datetime.datetime.fromisoformat(os.environ["STAMP"]).timestamp()))' 2>/dev/null
  fi
}

LATEST=""
while read -r stamp; do
  [ -n "$stamp" ] || continue
  epoch="$(to_epoch "$stamp" || true)"
  [ -n "$epoch" ] || continue
  if [ "$epoch" -gt "$EPOCH_FLOOR" ]; then LATEST="$epoch"; break; fi
done <<EOF
$(monitor_run_stamps || true)
EOF

if [ -z "${RUNS_JSON}" ]; then
  say "blocked the run list could not be read, so the gap is unknown — not a pass"
  exit 0
fi
if [ -z "${LATEST}" ]; then
  if command -v jq >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
    say "blocked no ${MONITOR_WORKFLOW} run has started yet — the gap is unknown, not a pass"
  else
    say "blocked neither jq nor python3 is present, so the gap could not be computed — not a pass"
  fi
  exit 0
fi

NOW="$(date -u +%s)"
AGE_MIN=$(( (NOW - LATEST) / 60 ))
if [ "$AGE_MIN" -gt "$MONITOR_MAX_GAP_MINUTES" ]; then
  say "FAIL the newest ${MONITOR_WORKFLOW} run is ${AGE_MIN} minutes old, past the ${MONITOR_MAX_GAP_MINUTES}-minute allowance"
  say "      the clock was stopped, or the runner has not been picking these up"
  exit 3
fi
say "ok newest ${MONITOR_WORKFLOW} run is ${AGE_MIN} minute(s) old"
