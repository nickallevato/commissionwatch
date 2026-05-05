import knex from "knex";
import config from "../../knexfile";

const env = (process.env.NODE_ENV || "development") as keyof typeof config;
const db = knex(config[env] || config.development);

export default db;
