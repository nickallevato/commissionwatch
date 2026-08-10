#!/usr/bin/env bash
#
# One command to get CommissionWatch running locally.
#
#   bash scripts/dev-setup.sh
#
# It starts Postgres and MinIO in Docker, installs both packages, applies every
# migration and loads the demonstration seed. It is safe to re-run: every step
# is idempotent, and nothing here reaches the network except npm and the two
# container images.
#
# What it deliberately does NOT do:
#
#   - It does not enable an ingestion source. A source row is created disabled,
#     and switching one on means this machine starts fetching a real county's
#     web server. That is a decision a person makes, not a side effect of
#     setting up a development environment. See `npm run sweep -- --list`.
#   - It does not create an operator. `OPERATOR_SEED_EMAIL` and
#     `OPERATOR_SEED_PASSWORD` in `backend/.env` create the first one at boot,
#     once, and only while the `operators` table is empty.
#
# Verified end to end on 2026-08-10 against Node v22.22.2 and Docker Compose
# v5.1.4 on Linux. Two honest caveats are in CONTRIBUTING.md rather than hidden
# here: the compose stack binds fixed host ports, and this script was last
# verified against containers that were already up.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    %s\033[0m\n' "$1"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# --------------------------------------------------------------------------
# 0. Prerequisites, named rather than assumed
# --------------------------------------------------------------------------
say "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "node is not installed. Node 22 or newer is required."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $NODE_MAJOR found; 22 or newer is required."
echo "    node $(node --version)"

command -v docker >/dev/null 2>&1 || die "docker is not installed."
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not available."
echo "    $(docker compose version)"

# --------------------------------------------------------------------------
# 1. Configuration
# --------------------------------------------------------------------------
say "Configuring backend/.env"

if [ -f backend/.env ]; then
  echo "    backend/.env exists; leaving it alone."
else
  cp backend/.env.example backend/.env
  echo "    Copied backend/.env.example to backend/.env."
fi
warn "Nothing in the Node process reads that file. There is no dotenv"
warn "dependency and no env_file in docker-compose.yml -- it is the template"
warn "for the deployed host's .env and a checklist of what the code reads."
warn "Locally the defaults in backend/knexfile.ts and src/services/storage.ts"
warn "already match this compose stack, so nothing needs exporting."

# --------------------------------------------------------------------------
# 2. Data services
# --------------------------------------------------------------------------
say "Starting Postgres and MinIO"

docker compose up -d db minio

echo "    Waiting for Postgres to accept connections..."
DB_SERVICE_ID=""
for _ in $(seq 1 60); do
  DB_SERVICE_ID="$(docker compose ps -q db)"
  if [ -n "$DB_SERVICE_ID" ] && docker exec "$DB_SERVICE_ID" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
[ -n "$DB_SERVICE_ID" ] || die "the db container did not start. Check 'docker compose logs db'."
docker exec "$DB_SERVICE_ID" pg_isready -U postgres >/dev/null 2>&1 \
  || die "Postgres did not become ready. Check 'docker compose logs db'."
echo "    Postgres is ready."

# `scripts/init-databases.sql` creates commissionwatch_test, but only on the
# first initialisation of the data volume. A volume that predates that file --
# or one carried over from an older checkout -- never runs it, and `npm test`
# then fails on a database that does not exist. Creating it here is idempotent
# and removes the trap rather than documenting it.
say "Ensuring the test database exists"
if docker exec "$DB_SERVICE_ID" psql -U postgres -lqt | cut -d'|' -f1 | grep -qw commissionwatch_test; then
  echo "    commissionwatch_test already exists."
else
  docker exec "$DB_SERVICE_ID" psql -U postgres -c 'CREATE DATABASE commissionwatch_test' >/dev/null
  echo "    Created commissionwatch_test."
fi

# --------------------------------------------------------------------------
# 3. Dependencies
# --------------------------------------------------------------------------
say "Installing backend dependencies"
(cd "$ROOT/backend" && npm ci)

say "Installing frontend dependencies"
(cd "$ROOT/frontend" && npm ci)

# --------------------------------------------------------------------------
# 4. Schema and seed
# --------------------------------------------------------------------------
say "Applying migrations"
(cd "$ROOT/backend" && npm run migrate)

# The seed deletes every row before inserting, which is why it must never run
# against production -- `backend/docker-entrypoint.sh` refuses when NODE_ENV is
# production. Locally it is exactly what you want: a demonstrable record.
say "Loading the demonstration seed"
(cd "$ROOT/backend" && npm run seed)

# --------------------------------------------------------------------------
# 5. What to do next
# --------------------------------------------------------------------------
say "Done"
cat <<'NEXT'
    Two terminals:

      cd backend  && npm run dev      # API on http://localhost:3001
      cd frontend && npm run dev      # site on http://localhost:3000

    Checks, which are what CI runs:

      cd backend  && npm run typecheck && npm run lint && npm test
      cd frontend && npm run typecheck && npm run lint && npm test -- --run

    The seeded record is demonstration data. It names no real person, and no
    source is switched on, so nothing has been fetched from anybody's web
    server by running this script.

      cd backend && npm run sweep -- --list      # what sources exist

NEXT
