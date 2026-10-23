// Shared fixtures for the source/job tests: fake clock, fake fetch, db setup.
const { createTestDb } = require("./db");

function fakeClock(startIso = "2026-10-05T10:00:00Z") {
  let t = new Date(startIso).getTime();
  const sleeps = [];
  return {
    now: () => new Date(t),
    set: (iso) => { t = new Date(iso).getTime(); },
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const json = (data, init = {}) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });

async function withDb(fn) {
  const { pool, cleanup } = await createTestDb();
  require("../../db").setPool(pool);
  try {
    await fn(pool);
  } finally {
    await cleanup();
  }
}

module.exports = { fakeClock, fakeFetch, json, withDb, PUBLIC_LOOKUP };
