const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePaymentAmount } = require("../utils/finance");

test("validatePaymentAmount rejects non-positive values", () => {
  const result = validatePaymentAmount({ amountPaid: 0, remainingAmount: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "amount_paid must be greater than zero");
});

test("validatePaymentAmount rejects overpayment", () => {
  const result = validatePaymentAmount({ amountPaid: 200, remainingAmount: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "amount_paid cannot exceed remaining invoice balance");
});

test("validatePaymentAmount computes next remaining and status", () => {
  const partial = validatePaymentAmount({ amountPaid: 40, remainingAmount: 100 });
  assert.equal(partial.ok, true);
  assert.equal(partial.remaining, 60);
  assert.equal(partial.status, "Partial");

  const paid = validatePaymentAmount({ amountPaid: 100, remainingAmount: 100 });
  assert.equal(paid.ok, true);
  assert.equal(paid.remaining, 0);
  assert.equal(paid.status, "Paid");
});
