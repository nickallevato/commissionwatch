#!/usr/bin/env bash
#
# Nightly backup of the CommissionWatch database and object store.
#
# This exists because P1 landed. Before ingestion ran, "no backups" was harmless
# — the site had zero rows and everything in it was reproducible from a seed
# file. The moment a sweep succeeded, the database started holding public
# records fetched at a point in time from sources that rewrite their own pages,
# and some of those bytes are no longer obtainable from the county. That is what
# is being protected here: not the schema, the evidence.
#
# What it does, in order:
#   1. pg_dump -Fc of the application database, from inside the db container.
#   2. A tar of every object in the MinIO bucket, taken with `mc mirror` and
#      copied out of the minio container.
#   3. A manifest recording row counts per table, so a restore has something to
#      be checked against rather than "it did not error".
#   4. Retention: 7 daily, 4 weekly (Sundays are promoted to weekly).
#   5. Optional off-instance copy to S3 with the host's instance role.
#   6. ops.backup_succeeded / ops.backup_failed through the delivery dispatcher.
#
# Usage:
#   deploy/backup.sh                 # back up, prune, notify
#   deploy/backup.sh --no-notify     # ...without emitting a delivery event
#   BACKUP_DIR=/tmp/x deploy/backup.sh
#
# Environment:
#   BACKUP_DIR        where archives land. Default /home/ec2-user/commissionwatch/backups
#   DB_CONTAINER      default commissionwatch-db      (local compose: commissionwatch-db-1)
#   MINIO_CONTAINER   default commissionwatch-minio   (local compose: commissionwatch-minio-1)
#   BACKEND_CONTAINER default commissionwatch-backend (used only to emit events)
#   POSTGRES_USER/POSTGRES_DB   default postgres/commissionwatch
#   MINIO_BUCKET      default meeting-documents
#   BACKUP_S3_URI     when set, e.g. s3://bucket/commissionwatch, the archive is
#                     ALSO copied there with `aws s3 cp`, which is the leg that
#                     makes this off-instance. Left unset by default because
#                     turning on a paid bucket is the operator's decision, not
#                     this script's.
#   DAILY_KEEP / WEEKLY_KEEP    default 7 / 4
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/ec2-user/commissionwatch/backups}"
DB_CONTAINER="${DB_CONTAINER:-commissionwatch-db}"
MINIO_CONTAINER="${MINIO_CONTAINER:-commissionwatch-minio}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-commissionwatch-backend}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-commissionwatch}"
MINIO_BUCKET="${MINIO_BUCKET:-meeting-documents}"
DAILY_KEEP="${DAILY_KEEP:-7}"
WEEKLY_KEEP="${WEEKLY_KEEP:-4}"
NOTIFY=1

for arg in "$@"; do
  case "$arg" in
    --no-notify) NOTIFY=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAY_OF_WEEK="$(date -u +%u)"   # 7 = Sunday
DAILY_DIR="$BACKUP_DIR/daily"
WEEKLY_DIR="$BACKUP_DIR/weekly"
WORK="$DAILY_DIR/$STAMP"

log()  { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '[backup %s] FAILED: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# The event goes through the application's own dispatcher, so a backup failure
# reaches whatever channels the operator already configured rather than a
# second, parallel notification path nobody remembers exists. A dispatcher that
# is unreachable is itself reported, loudly, on stderr — a silent notifier is
# the failure this is meant to prevent.
emit() {
  local event="$1" detail="$2"
  [ "$NOTIFY" -eq 1 ] || return 0
  if ! docker ps --format '{{.Names}}' | grep -qx "$BACKEND_CONTAINER"; then
    fail "cannot emit ${event}: no container named ${BACKEND_CONTAINER}"
    return 0
  fi
  if ! docker exec "$BACKEND_CONTAINER" node dist/src/scripts/emit-ops-event.js \
        --event "$event" --detail "$detail" --source backup.sh; then
    fail "cannot emit ${event}: the dispatcher call failed"
  fi
}

on_error() {
  local line="$1"
  fail "aborted at line ${line}"
  rm -rf "$WORK"
  emit "ops.backup_failed" "backup.sh aborted at line ${line} on $(hostname)"
  exit 1
}
trap 'on_error $LINENO' ERR

mkdir -p "$WORK" "$WEEKLY_DIR"

# --- 1. Database -----------------------------------------------------------
# Custom format (-Fc): compressed, and restorable table-by-table with pg_restore,
# which is what makes the drill's per-table comparison possible.
log "dumping ${POSTGRES_DB} from ${DB_CONTAINER}"
docker exec "$DB_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "$WORK/database.dump"
DB_BYTES="$(wc -c < "$WORK/database.dump")"
if [ "$DB_BYTES" -lt 1024 ]; then
  fail "dump is only ${DB_BYTES} bytes; refusing to call that a backup"
  exit 1
fi
log "database.dump ${DB_BYTES} bytes"

# --- 2. Object store -------------------------------------------------------
# `mc` ships in the minio image, and its bundled `local` alias is
# unauthenticated, so the alias is set from the container's own root credentials.
# Those credentials never leave the container.
#
# The mirror is copied out with `docker cp` and tarred on the host rather than
# streamed as a tar out of the container: the minio image has no `tar`, which is
# the sort of thing you learn by running the script rather than by writing it.
log "mirroring bucket ${MINIO_BUCKET} from ${MINIO_CONTAINER}"
docker exec "$MINIO_CONTAINER" sh -c '
  set -e
  mc alias set cwbackup http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  rm -rf /tmp/cwbackup && mkdir -p /tmp/cwbackup
  mc mirror --quiet "cwbackup/'"$MINIO_BUCKET"'" /tmp/cwbackup >/dev/null
' >/dev/null
docker cp "$MINIO_CONTAINER:/tmp/cwbackup" "$WORK/objects" >/dev/null
docker exec "$MINIO_CONTAINER" rm -rf /tmp/cwbackup
tar -C "$WORK" -cf "$WORK/objects.tar" objects
rm -rf "$WORK/objects"
OBJ_BYTES="$(wc -c < "$WORK/objects.tar")"
OBJ_COUNT="$(tar -tf "$WORK/objects.tar" | grep -vc '/$' || true)"
log "objects.tar ${OBJ_BYTES} bytes, ${OBJ_COUNT} object(s)"

# --- 3. Manifest -----------------------------------------------------------
# Row counts at dump time. Without this a restore can only assert "no error",
# which is not the same as "the rows came back".
log "recording row counts"
docker exec "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F, -c "
  SELECT relname, n_live_tup
  FROM pg_stat_user_tables
  ORDER BY relname
" > "$WORK/rowcounts.csv"

{
  echo "created_at=$STAMP"
  echo "host=$(hostname)"
  echo "database=$POSTGRES_DB"
  echo "bucket=$MINIO_BUCKET"
  echo "database_bytes=$DB_BYTES"
  echo "objects_bytes=$OBJ_BYTES"
  echo "objects_count=$OBJ_COUNT"
  echo "postgres_version=$(docker exec "$DB_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c 'SHOW server_version')"
} > "$WORK/manifest.txt"

ARCHIVE="$DAILY_DIR/commissionwatch-$STAMP.tar.gz"
tar -C "$WORK" -czf "$ARCHIVE" database.dump objects.tar rowcounts.csv manifest.txt
rm -rf "$WORK"
ARCHIVE_BYTES="$(wc -c < "$ARCHIVE")"
log "archive $ARCHIVE ($ARCHIVE_BYTES bytes)"

# --- 4. Retention ----------------------------------------------------------
# Sunday's archive is hard-linked into weekly/ rather than copied: it is the same
# bytes, so a weekly retention costs nothing until the daily copy is pruned.
if [ "$DAY_OF_WEEK" = "7" ]; then
  ln -f "$ARCHIVE" "$WEEKLY_DIR/$(basename "$ARCHIVE")"
  log "promoted to weekly"
fi

prune() {
  local dir="$1" keep="$2"
  # Listed newest-first and dropped past `keep`. Deliberately not `find -mtime`:
  # a run that skips a night must not silently widen the window.
  local victims
  victims="$(ls -1t "$dir"/commissionwatch-*.tar.gz 2>/dev/null | tail -n +"$((keep + 1))" || true)"
  [ -n "$victims" ] || return 0
  echo "$victims" | while read -r victim; do
    log "pruning $(basename "$victim")"
    rm -f "$victim"
  done
}
prune "$DAILY_DIR" "$DAILY_KEEP"
prune "$WEEKLY_DIR" "$WEEKLY_KEEP"

# --- 5. Off-instance -------------------------------------------------------
# The leg that makes this a backup rather than a copy. An archive that lives
# only on the instance it was taken from protects against a bad migration and
# nothing else.
if [ -n "${BACKUP_S3_URI:-}" ]; then
  log "copying off-instance to ${BACKUP_S3_URI}"
  AWS_PAGER="" aws s3 cp "$ARCHIVE" "${BACKUP_S3_URI%/}/$(basename "$ARCHIVE")"
  OFFSITE="${BACKUP_S3_URI%/}/$(basename "$ARCHIVE")"
else
  OFFSITE="(none — BACKUP_S3_URI unset, this archive is on the instance only)"
  log "BACKUP_S3_URI is unset; the archive has NOT left the instance"
fi

emit "ops.backup_succeeded" \
  "$(basename "$ARCHIVE") ${ARCHIVE_BYTES} bytes; db ${DB_BYTES}; objects ${OBJ_BYTES}; offsite ${OFFSITE}"
log "done"
