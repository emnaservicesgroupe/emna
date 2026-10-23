// Deterministic in-memory adapter. Registered ONLY when NODE_ENV === 'test' (see ./index.js).
const { RateLimited } = require("./errors");

const KEY = "test_fixture";
const state = { jobs: [], details: new Map(), failWith: null, calls: 0, searchCalls: [] };

module.exports = {
  key: KEY,
  describe: () => ({ name: "Test fixture", termsUrl: null, rateLimitPerMin: 60, requires: [] }),
  status: () => ({ status: "connected", detail: "Test fixture (NODE_ENV=test only)" }),
  async search(query) {
    state.calls += 1;
    state.searchCalls.push(query);
    if (state.failWith) {
      if (state.failWith === "429") throw new RateLimited(2000);
      throw new Error(state.failWith);
    }
    return state.jobs.map((j) => ({ ...j }));
  },
  async fetchDetail(sourceJobId) {
    if (state.failWith) throw new Error(state.failWith);
    const d = state.details.get(String(sourceJobId));
    if (d instanceof Error) throw d;
    if (d !== undefined) return d;
    const j = state.jobs.find((x) => x.sourceJobId === String(sourceJobId));
    return j ? { ...j } : null;
  },
  /** test helpers */
  _set({ jobs, failWith } = {}) {
    if (jobs !== undefined) state.jobs = jobs;
    if (failWith !== undefined) state.failWith = failWith;
  },
  _detail: (id, value) => state.details.set(String(id), value),
  _reset() {
    state.jobs = [];
    state.details = new Map();
    state.failWith = null;
    state.calls = 0;
    state.searchCalls = [];
  },
  _state: state,
};
