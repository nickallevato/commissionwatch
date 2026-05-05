import knex, { Knex } from 'knex';
import { config } from './config';

let instance: Knex | null = null;

export function getDb(): Knex {
  if (!instance) {
    instance = knex({
      client: 'pg',
      connection: config.databaseUrl,
      pool: { min: 1, max: 5 },
    });
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
}
