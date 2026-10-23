// Money and quantity parsing for the accounting module. Amounts travel as decimal STRINGS ("12.50"); this module
// never converts them to floats for arithmetic. Arithmetic and comparison happen in SQL on NUMERIC.
//
// Accepted input: a string of plain decimal digits with an optional "." fraction (no sign, exponent, comma, spaces,
// "NaN"/"Infinity"), or a JSON number whose String() form is already a plain decimal (so 12.5 and 0.1 pass, 1e21,
// 1e-7 and 0.001 do not). The result is normalised to exactly 2 decimals and no leading zeros.
const { HttpError } = require("../jobsearch/httpError");

const PLAIN = /^(\d+)(?:\.(\d+))?$/;

function plainDecimal(value, label) {
  let s;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(400, `${label} must be a valid decimal number`);
    s = String(value);
  } else if (typeof value === "string") {
    s = value.trim();
  } else {
    throw new HttpError(400, `${label} must be a decimal string or number`);
  }
  const m = PLAIN.exec(s);
  if (!m) throw new HttpError(400, `${label} must be a plain positive decimal (no sign, exponent or comma)`);
  return { int: m[1].replace(/^0+(?=\d)/, ""), frac: m[2] || "" };
}

/**
 * Parses a money amount (>= 0, at most 2 decimals) into a normalised "N.NN" string.
 * @param {string|number} value
 * @param {{label?: string, maxIntDigits?: number, positive?: boolean}} [opts]
 */
function parseMoney(value, { label = "amount", maxIntDigits = 12, positive = false } = {}) {
  const { int, frac } = plainDecimal(value, label);
  if (frac.length > 2) throw new HttpError(400, `${label} must have at most 2 decimals`);
  if (int.length > maxIntDigits) throw new HttpError(400, `${label} is too large`);
  const out = `${int}.${frac.padEnd(2, "0")}`;
  if (positive && /^0\.00$/.test(out)) throw new HttpError(400, `${label} must be greater than zero`);
  return out;
}

/** Quantity: > 0, at most 2 decimals, at most 8 integer digits (the invoice_items.quantity column is numeric(10,2)). */
function parseQuantity(value, { label = "quantity", maxIntDigits = 8 } = {}) {
  return parseMoney(value, { label, maxIntDigits, positive: true });
}

/**
 * Formats a normalised decimal string for display: digit grouping of the integer part, no float maths.
 * formatMoney("1234567.5") -> "1,234,567.50"; with a currency: "1,234.00 TND". Non-decimal input is returned as-is.
 */
function formatMoney(value, currency, { sep = "," } = {}) {
  const s = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const m = PLAIN.exec(s.trim());
  if (!m) return s;
  const int = m[1].replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const out = `${int}.${(m[2] || "").slice(0, 2).padEnd(2, "0")}`;
  return currency ? `${out} ${currency}` : out;
}

module.exports = { parseMoney, parseQuantity, formatMoney };
