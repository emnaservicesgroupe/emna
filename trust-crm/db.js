require("dotenv").config();
const { Pool } = require("pg");

function buildPool() {
  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (connectionString) {
    return new Pool({ connectionString });
  }
  return new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
  });
}

let current = buildPool();

// Delegating proxy: callers must `require("../db")` and call db.query/connect at
// use time so tests can swap the underlying pool with setPool().
const db = {
  query: (...args) => current.query(...args),
  connect: (...args) => current.connect(...args),
  end: (...args) => current.end(...args),
  setPool(pool) {
    const previous = current;
    current = pool;
    return previous;
  },
};

module.exports = db;
