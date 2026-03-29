function validatePaymentAmount({ amountPaid, remainingAmount }) {
  const paid = Number(amountPaid);
  const remaining = Number(remainingAmount);

  if (!Number.isFinite(paid) || paid <= 0) {
    return { ok: false, error: "amount_paid must be greater than zero" };
  }

  if (!Number.isFinite(remaining) || remaining < 0) {
    return { ok: false, error: "Invalid invoice remaining amount" };
  }

  if (paid > remaining) {
    return { ok: false, error: "amount_paid cannot exceed remaining invoice balance" };
  }

  const nextRemaining = remaining - paid;
  return {
    ok: true,
    paid,
    remaining: nextRemaining,
    status: nextRemaining === 0 ? "Paid" : "Partial",
  };
}

module.exports = { validatePaymentAmount };
