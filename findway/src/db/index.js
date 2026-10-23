'use strict';
const { Pool, types } = require('pg');

// Return numeric/bigint as JS numbers (our values stay well inside safe range); dates stay as strings for DATE.
types.setTypeParser(20, (v) => Number(v));       // int8
types.setTypeParser(1700, (v) => Number(v));     // numeric
types.setTypeParser(1082, (v) => v);             // date -> 'YYYY-MM-DD'

function createDb(connectionString) {
  const pool = new Pool({ connectionString, max: 10 });
  const wrap = (client) => ({
    query: (text, params) => client.query(text, params),
    one: async (text, params) => (await client.query(text, params)).rows[0] || null,
    rows: async (text, params) => (await client.query(text, params)).rows,
  });
  const db = {
    ...wrap(pool),
    pool,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

module.exports = { createDb };
