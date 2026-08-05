-- Runs once, on first initialisation of the `db` service's data volume.
-- POSTGRES_DB already creates `commissionwatch` (the development database);
-- this adds the test database that `NODE_ENV=test` uses via
-- backend/knexfile.ts, so `npm test` works against the compose stack.
CREATE DATABASE commissionwatch_test;
