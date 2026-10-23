const test = require("node:test");
const assert = require("node:assert/strict");
const { trustProxySetting } = require("../utils/trustProxy");

test("TRUST_PROXY: unset/false keep the Express default; hop counts and address lists are accepted", () => {
  for (const v of [undefined, null, "", " ", "false", "0", "off", "no"]) assert.equal(trustProxySetting(v), null);
  assert.equal(trustProxySetting("1"), 1);
  assert.equal(trustProxySetting(" 2 "), 2);
  assert.deepEqual(trustProxySetting("loopback"), ["loopback"]);
  assert.deepEqual(trustProxySetting("loopback, 10.0.0.0/8"), ["loopback", "10.0.0.0/8"]);
});

test("TRUST_PROXY: 'true' / '*' are refused (would trust a spoofed X-Forwarded-For)", () => {
  for (const v of ["true", "TRUE", "yes", "on", "*"]) assert.throws(() => trustProxySetting(v), /hop count/);
});

test("TRUST_PROXY=1: req.ip is the client from X-Forwarded-For; without it the header is ignored", async () => {
  const express = require("express");
  const ipOf = async (setting) => {
    const app = express();
    if (setting !== null) app.set("trust proxy", setting);
    app.get("/ip", (req, res) => res.json({ ip: req.ip }));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/ip`, { headers: { "X-Forwarded-For": "203.0.113.7" } });
      return (await r.json()).ip;
    } finally {
      server.close();
    }
  };
  assert.equal(await ipOf(trustProxySetting("1")), "203.0.113.7");
  assert.notEqual(await ipOf(trustProxySetting(undefined)), "203.0.113.7");
});

test("app.js applies TRUST_PROXY at load time", () => {
  process.env.TRUST_PROXY = "1";
  delete require.cache[require.resolve("../app")];
  const app = require("../app");
  assert.equal(app.get("trust proxy"), 1);
  delete process.env.TRUST_PROXY;
});
