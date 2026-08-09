#!/usr/bin/env bash
#
# Restore a CommissionWatch backup into a scratch database and compare row
# counts against the source.
#
# A backup nobody has restored is a hypothesis. This is the script that turns it
# into a fact, and it is a script rather than a paragraph in a runbook precisely
# so it can be re-run — after a schema change, after a Postgres upgrade, after
# anything that makes yesterday's evidence stale.
#
# It restores into a NEW database on the running instance, never over the live
# one, and drops it afterwards unless told to keep it.
#
# Usage:
#   deploy/restore-drill.sh                                   # newest daily archive
#   deploy/restore-drill.sh --archive /path/to/backup.tar.gz
#   deploy/restore-drill.sh --keep                            # leave the scratch db
#
# Environment: same as backup.sh, plus
#   SCRATCH_DB   name of the scratch database. Default commissionwatch_restore_drill
#
# ---------------------------------------------------------------------------
# The POSTGRES_PASSWORD trap, recorded because it has already cost this project
# a deploy:
#
#   POSTGRES_PASSWORD is read by the postgres image ONLY when it initialises an
#   empty data volume. Changing the secret afterwards does not change the
#   database; the role keeps the password the volume was born with.
#
# This drill therefore restores into a scratch database on the ALREADY RUNNING
# instance, using the credentials that instance actually answers to, and never
# depends on the secret being in sync. A restore into a FRESH volume is a
# different procedure: the new volume initialises with whatever POSTGRES_PASSWORD
# is set at that moment, so DATABASE_URL must be made to match the new value —
# or the restore must be followed by `ALTER ROLE ... WITH PASSWORD` on the
# running instance. See deploy/README.md §5.
# ---------------------------------------------------------------------------
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/ec2-user/commissionwatch/backups}"
DB_CONTAINER="${DB_CONTAINER:-commissionwatch-db}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-commissionwatch}"
SCRATCH_DB="${SCRATCH_DB:-commissionwatch_restore_drill}"
ARCHIVE=""
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="${2:-}"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

log()  { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(ls -1t "$BACKUP_DIR"/daily/commissionwatch-*.tar.gz 2>/dev/null | head -1 || true)"
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  fail "no archive to restore (looked in $BACKUP_DIR/daily). Run deploy/backup.sh first."
  exit 2
fi
log "restoring $ARCHIVE"

WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  if [ "$KEEP" -eq 0 ]; then
    docker exec "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

tar -C "$WORK" -xzf "$ARCHIVE"
for required in database.dump rowcounts.csv manifest.txt; do
  if [ ! -f "$WORK/$required" ]; then
    fail "archive is missing $required — it is not a CommissionWatch backup"
    exit 3
  fi
done
log "manifest: $(tr '\n' ' ' < "$WORK/manifest.txt")"

# A fresh scratch database every time. Restoring into a database that already
# has rows would let a drill pass on data the dump never contained.
log "creating scratch database $SCRATCH_DB"
docker exec "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" >/dev/null
docker exec "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"$SCRATCH_DB\"" >/dev/null

log "running pg_restore"
# pg_restore reports non-fatal complaints (an extension owned by another role,
# for instance) with a non-zero exit under --exit-on-error, and hides real ones
# without it. So: no --exit-on-error, capture everything, and let the row-count
# comparison below be the thing that decides whether the restore worked. A dump
# that "restored cleanly" but produced no rows must fail this script.
set +e
docker exec -i "$DB_CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$SCRATCH_DB" --no-owner --no-acl \
  < "$WORK/database.dump" > "$WORK/restore.log" 2>&1
RESTORE_STATUS=$?
set -e
if [ "$RESTORE_STATUS" -ne 0 ]; then
  log "pg_restore exited ${RESTORE_STATUS}; warnings follow, row counts decide"
  sed -n '1,20p' "$WORK/restore.log" | sed 's/^/    /'
fi

# ANALYZE, because the comparison below reads live row estimates on the source
# and exact counts on the scratch copy; stale statistics on either side would
# make a correct restore look wrong.
docker exec "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -c "ANALYZE" >/dev/null

log ""
log "TABLE                          IN DUMP   RESTORED   RESULT"
STATUS=0
CHECKED=0
TOTAL_ROWS=0
while IFS=, read -r table expected; do
  [ -n "$table" ] || continue
  actual="$(docker exec "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d "$SCRATCH_DB" -At \
    -c "SELECT count(*) FROM \"$table\"" 2>/dev/null || echo "MISSING")"
  CHECKED=$((CHECKED + 1))
  if [ "$actual" = "MISSING" ]; then
    printf '[drill] %-30s %8s %10s   TABLE MISSING\n' "$table" "$expected" "-" >&2
    STATUS=1
    continue
  fi
  TOTAL_ROWS=$((TOTAL_ROWS + actual))
  # pg_stat_user_tables.n_live_tup is an estimate, so an exact match is not
  # required for it to be a pass — a table that had rows and came back empty is
  # what this is looking for, and that is unambiguous.
  if [ "$expected" -gt 0 ] && [ "$actual" -eq 0 ]; then
    printf '[drill] %-30s %8s %10s   LOST\n' "$table" "$expected" "$actual" >&2
    STATUS=1
  elif [ "$actual" -lt "$expected" ]; then
    printf '[drill] %-30s %8s %10s   SHORT\n' "$table" "$expected" "$actual" >&2
    STATUS=1
  else
    printf '[drill] %-30s %8s %10s   ok\n' "$table" "$expected" "$actual"
  fi
done < "$WORK/rowcounts.csv"

log ""
log "$CHECKED table(s) compared, $TOTAL_ROWS row(s) restored"

if [ -f "$WORK/objects.tar" ]; then
  OBJECT_COUNT="$(tar -tf "$WORK/objects.tar" | grep -vc '/$' || true)"
  log "object store archive carries $OBJECT_COUNT object(s)"
fi

if [ "$STATUS" -ne 0 ]; then
  fail "RESTORE DRILL FAILED — see the rows marked LOST or SHORT above"
  exit 1
fi

if [ "$KEEP" -eq 1 ]; then
  log "scratch database $SCRATCH_DB left in place (--keep)"
fi
log "RESTORE DRILL PASSED"
