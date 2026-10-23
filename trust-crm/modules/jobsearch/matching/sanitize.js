// Thin wrapper over the job store sanitiser (single implementation). All job/CV text passes through
// here before storage or display; matching treats the result as inert data.
const { sanitizeText } = require("../jobStore");

const DEFAULT_MAX = 20000;

/** Strips control chars/markup and truncates. Always returns a string. */
function sanitizeUntrusted(text, max = DEFAULT_MAX) {
  return sanitizeText(text, max);
}

module.exports = { sanitizeUntrusted };
