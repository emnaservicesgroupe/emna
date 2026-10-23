// Source adapter registry. `test_fixture` exists only when NODE_ENV === 'test'.
const jobbankCa = require("./jobbankCa");
const partnerFeed = require("./partnerFeed");
const manualImport = require("./manualImport");

function adapters() {
  const list = [jobbankCa, partnerFeed, manualImport];
  if (process.env.NODE_ENV === "test") list.push(require("./testFixture"));
  return list;
}

const keys = () => adapters().map((a) => a.key);
const getAdapter = (key) => adapters().find((a) => a.key === key) || null;

module.exports = { adapters, keys, getAdapter };
