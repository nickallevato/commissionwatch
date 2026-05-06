#!/bin/sh
set -e

echo "Running database migrations..."
node --import tsx ./node_modules/.bin/knex migrate:latest --knexfile knexfile.ts
echo "Migrations complete."

exec "$@"
