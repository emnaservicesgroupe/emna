const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../app");

test("GET / returns healthy API metadata", async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.system, "EMNA Services CRM");
    assert.equal(body.status, "Running");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
