#!/bin/sh
#
# Migrations run here, before the server listens, so the container is never
# serving against a schema it does not expect.
#
# The failure path is loud on purpose. Under a bare `set -e` a failed
# `knex migrate:latest` exited silently with knex's own status, which in a
# restart loop is indistinguishable from every other crash: `docker logs`
# shows the same handful of lines whether the database is unreachable, a
# migration threw, or the process died later. Naming the stage and the exit
# status makes the first line of the log the answer.
set -e

echo "[entrypoint] Running database migrations..."
# Captured with `|| status=$?` rather than `if ! ...; then status=$?`: inside a
# negated `if` the special parameter holds the status of the negation, which is
# always 0, so that spelling would report "exit 0" for a failure and then exit 0.
status=0
node --import tsx ./node_modules/.bin/knex migrate:latest --knexfile knexfile.ts || status=$?
if [ "${status}" -ne 0 ]; then
  echo "[entrypoint] FATAL: database migration failed (exit ${status})." >&2
  echo "[entrypoint] The server was NOT started. The container will exit and, under" >&2
  echo "[entrypoint] restart: unless-stopped, restart into the same failure." >&2
  echo "[entrypoint] Check DATABASE_URL, that the database is reachable, and the" >&2
  echo "[entrypoint] knex error above for the migration that threw." >&2
  exit "${status}"
fi
echo "[entrypoint] Migrations complete."

exec "$@"
