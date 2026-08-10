#!/usr/bin/env bash
#
# Tests for deploy/monitor-trigger.sh.
#
# The trigger is the only thing standing between a monitor that runs and a
# monitor that sits registered and never fires, so the parts that would fail
# silently are the parts under test:
#
#   1. **It sends what it says it sends.** A POST, to the dispatches path, with
#      the ref in the body. A trigger that quietly GETs something is a trigger
#      that reports success forever while nothing runs.
#   2. **The token never reaches argv.** `ps` and /proc/<pid>/cmdline are
#      readable by every user on the machine, and one of the two places this is
#      meant to run is a host shared with seven other products.
#   3. **The two timestamp traps this Gitea sets.** `started_at` carries an
#      offset rather than a `Z`, and a queued run reports epoch zero rather than
#      null. Getting either wrong turns a healthy tick into a failure, or — far
#      worse — a stopped clock into a pass.
#   4. **Blocked is not pass.** A gap that could not be computed says so.
#
# Run: ./deploy/test-monitor-trigger.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/monitor-trigger.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ok   $*"; }
bad()   { FAIL=$((FAIL+1)); echo "  FAIL $*" >&2; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3], got [$2])"; fi; }
contains() {
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing [$3] in [$2])" ;; esac
}
excludes() {
  case "$2" in *"$3"*) bad "$1 (found [$3])" ;; *) ok "$1" ;; esac
}

TOKEN="stub-token-2f9c-not-a-real-credential"

# ── Stub curl ───────────────────────────────────────────────────────────────
# The real script feeds curl its whole request on stdin via `--config -`, so the
# stub reads stdin and records both what it was given as arguments and what it
# was given on the wire. That split is what makes the "no token in argv" test
# mean anything.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
CONFIG="$(cat)"
printf '%s\n' "$*" >> "${STUB_ARGV:?}"
{ printf '%s\n' "$CONFIG"; printf -- '--\n'; } >> "${STUB_CONFIG:?}"
url="$(printf '%s' "$CONFIG" | sed -n 's/^url = "\(.*\)"$/\1/p')"
case "$url" in
  */dispatches) printf '%s' "${STUB_DISPATCH_CODE:-204}" ;;
  */actions/runs) [ -n "${STUB_RUNS_FILE:-}" ] && cat "$STUB_RUNS_FILE" ;;
esac
exit "${STUB_CURL_EXIT:-0}"
STUB
chmod +x "$TMP/bin/curl"

# A runs list in this Gitea's actual shape, built around a chosen age.
runs_fixture() {
  # $1 minutes ago for the newest *started* monitor run
  # $2 (optional) "queued" to put an unstarted run in front of it
  local started queued_block=""
  started="$(date -d "-$1 minutes" +%Y-%m-%dT%H:%M:%S%:z)"
  if [ "${2:-}" = "queued" ]; then
    # Exactly what this Gitea returns for a run that has not started: epoch zero
    # rendered in the instance's local zone, not null.
    queued_block='{"id":2,"path":"monitor.yml@refs/heads/main","event":"workflow_dispatch","status":"waiting","conclusion":null,"started_at":"1969-12-31T17:00:00-07:00"},'
  fi
  cat > "$TMP/runs.json" <<JSON
{"workflow_runs":[
  ${queued_block}
  {"id":3,"path":"deploy.yml@refs/heads/main","event":"push","status":"completed","conclusion":"success","started_at":"$(date -d '-1 minutes' +%Y-%m-%dT%H:%M:%S%:z)"},
  {"id":1,"path":"monitor.yml@refs/heads/main","event":"workflow_dispatch","status":"completed","conclusion":"success","started_at":"${started}"}
]}
JSON
  echo "$TMP/runs.json"
}

run_trigger() {
  # Every invocation gets its own recorders. HOME is redirected so the real
  # operator's token file can never be picked up by a test.
  : > "$TMP/argv"; : > "$TMP/config"
  env -i \
    PATH="$TMP/bin:$PATH" \
    HOME="$TMP/home" \
    STUB_ARGV="$TMP/argv" \
    STUB_CONFIG="$TMP/config" \
    STUB_DISPATCH_CODE="${DISPATCH_CODE:-204}" \
    STUB_CURL_EXIT="${CURL_EXIT:-0}" \
    STUB_RUNS_FILE="${RUNS_FILE:-}" \
    GITEA_TOKEN="${TOKEN_FOR_RUN-}" \
    GITEA_ENV_FILE="${ENV_FILE_FOR_RUN:-$TMP/home/.config/commissionwatch/gitea.env}" \
    GITEA_URL="https://gitea.example.invalid" \
    GITEA_REPO="your-org/commissionwatch" \
    bash "$SCRIPT" "$@" 2>&1
}

mkdir -p "$TMP/home"

echo "dry run"
OUT="$(TOKEN_FOR_RUN="$TOKEN" run_trigger --dry-run)"; CODE=$?
check "exits 0" "$CODE" "0"
contains "names the dispatch URL it would POST" "$OUT" \
  "https://gitea.example.invalid/api/v1/repos/your-org/commissionwatch/actions/workflows/monitor.yml/dispatches"
contains "says a token was found" "$OUT" "token: present"
excludes "never prints the token itself" "$OUT" "$TOKEN"
check "sends nothing at all" "$(wc -l < "$TMP/argv" | tr -d ' ')" "0"

echo
echo "configuration"
OUT="$(TOKEN_FOR_RUN="" run_trigger)"; CODE=$?
check "no token exits 1" "$CODE" "1"
contains "says where the token is meant to live" "$OUT" "GITEA_TOKEN is not set"
check "and sends nothing" "$(wc -l < "$TMP/argv" | tr -d ' ')" "0"

OUT="$(TOKEN_FOR_RUN="$TOKEN" run_trigger --nonsense)"; CODE=$?
check "an unknown argument exits 1 rather than dispatching" "$CODE" "1"
check "and sends nothing" "$(wc -l < "$TMP/argv" | tr -d ' ')" "0"

# The env file is a convenience, and an exported token must win over it — a cron
# entry has to be able to supply the token from somewhere else.
mkdir -p "$TMP/home/.config/commissionwatch"
printf 'GITEA_TOKEN=token-from-the-file\n' > "$TMP/home/.config/commissionwatch/gitea.env"
RUNS_FILE="$(runs_fixture 5)" TOKEN_FOR_RUN="" run_trigger > /dev/null
contains "reads the token from the env file when none is exported" \
  "$(cat "$TMP/config")" "token-from-the-file"
RUNS_FILE="$(runs_fixture 5)" TOKEN_FOR_RUN="$TOKEN" run_trigger > /dev/null
excludes "an exported token wins over the file" "$(cat "$TMP/config")" "token-from-the-file"
rm -f "$TMP/home/.config/commissionwatch/gitea.env"

echo
echo "the request"
OUT="$(RUNS_FILE="$(runs_fixture 5)" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
check "a healthy tick exits 0" "$CODE" "0"
contains "reports the dispatch" "$OUT" "ok dispatched monitor.yml@main (http=204)"
CONFIG="$(cat "$TMP/config")"
contains "POSTs" "$CONFIG" 'request = "POST"'
contains "to the dispatches path" "$CONFIG" "/actions/workflows/monitor.yml/dispatches"
contains "with the ref in the body" "$CONFIG" 'data = "{\"ref\":\"main\"}"'
contains "and the token as a header" "$CONFIG" "Authorization: token ${TOKEN}"
# The security property. curl is invoked as `--config -` and nothing else.
excludes "the token never reaches argv" "$(cat "$TMP/argv")" "$TOKEN"
check "curl is driven entirely from stdin" "$(sort -u "$TMP/argv" | tr -d ' ')" "--config-"

echo
echo "a dispatch that is refused is not a pass"
OUT="$(DISPATCH_CODE=401 RUNS_FILE="$(runs_fixture 5)" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
check "401 exits 2" "$CODE" "2"
contains "and names the token as the likely cause" "$OUT" "the token is missing, wrong"

OUT="$(DISPATCH_CODE=404 RUNS_FILE="$(runs_fixture 5)" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
check "404 exits 2" "$CODE" "2"
contains "and names the workflow as the likely cause" "$OUT" "is not registered on main"

OUT="$(CURL_EXIT=7 RUNS_FILE="$(runs_fixture 5)" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
check "a request that could not be made at all exits 2" "$CODE" "2"

echo
echo "the gap, and the two timestamp traps"
# `started_at` carries an offset, not a Z. Reading nineteen characters as UTC
# would make this five-minute-old run look hours old wherever the instance is
# not on UTC — which is the whole of the failure mode.
OUT="$(RUNS_FILE="$(runs_fixture 5)" TOKEN_FOR_RUN="$TOKEN" run_trigger)"
contains "an offset stamp is read in its own zone" "$OUT" "run is 5 minute(s) old"

# A run that has been created but not started reports epoch zero, not null. Read
# blindly, the run this very dispatch created makes the clock look fifty-six
# years behind — a false alarm on every single healthy tick.
OUT="$(RUNS_FILE="$(runs_fixture 5 queued)" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
check "a queued run is not read as a date" "$CODE" "0"
contains "the newest started run is the one measured" "$OUT" "run is 5 minute(s) old"

OUT="$(RUNS_FILE="$(runs_fixture 180)" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
check "a three-hour gap exits 3" "$CODE" "3"
contains "and says the clock was stopped" "$OUT" "the clock was stopped"

# Only monitor runs count. The repository pushes constantly, so measuring the
# gap against any run at all would report a healthy clock forever.
cat > "$TMP/deploy-only.json" <<JSON
{"workflow_runs":[
  {"id":3,"path":"deploy.yml@refs/heads/main","event":"push","status":"completed","conclusion":"success","started_at":"$(date -d '-1 minutes' +%Y-%m-%dT%H:%M:%S%:z)"}
]}
JSON
OUT="$(RUNS_FILE="$TMP/deploy-only.json" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
contains "a deploy run is not counted as a monitor run" "$OUT" "no monitor.yml run has started yet"
check "and that is reported as blocked, exit 0" "$CODE" "0"
excludes "blocked never reads as ok" "$OUT" "ok newest"

echo
echo "blocked is not pass"
OUT="$(RUNS_FILE="" TOKEN_FOR_RUN="$TOKEN" run_trigger)"; CODE=$?
contains "an unreadable run list says the gap is unknown" "$OUT" "the gap is unknown"
contains "and says blocked" "$OUT" "blocked"
check "without claiming the monitor is healthy" "$CODE" "0"

echo
echo "── $PASS passed / $FAIL failed"
[ "$FAIL" -eq 0 ]
