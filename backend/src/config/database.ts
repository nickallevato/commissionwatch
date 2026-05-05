import knex from "knex";

const db = knex({
  client: "pg",
  connection:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/commissionwatch",
  pool: { min: 2, max: 10 },
});

export default db;
