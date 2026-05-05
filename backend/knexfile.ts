import type { Knex } from 'knex';

const connection = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/commissionwatch';

const shared: Partial<Knex.Config> = {
  client: 'pg',
  connection,
  migrations: {
    directory: './migrations',
    extension: 'ts',
  },
  seeds: {
    directory: './seeds',
    extension: 'ts',
  },
};

const config: Record<string, Knex.Config> = {
  development: {
    ...shared,
    pool: { min: 2, max: 10 },
  },
  test: {
    ...shared,
    connection: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/commissionwatch_test',
    pool: { min: 2, max: 10 },
  },
  production: {
    ...shared,
    pool: { min: 2, max: 20 },
  },
};

export default config;
