// Password strength for staff accounts created through /auth/bootstrap-super-admin and /auth/register.
// Rules: at least 12 characters, not on a small list of common passwords, and not containing the local
// part of the account's e-mail address (case-insensitive; dots, plus-tags and separators ignored).
// Returns null when acceptable, else a short, user-facing reason (the password itself is never echoed).
const MIN_LENGTH = 12;

// Lower-cased; compared after stripping separators/punctuation, so "Password-123!" matches "password123".
const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234", "password12345", "passw0rd", "p4ssw0rd",
  "123456789012", "1234567890123", "12345678901234", "123456123456", "111111111111", "000000000000", "abcdefghijkl",
  "qwertyuiop", "qwertyuiop12", "qwertyuiop123", "qwerty123456", "1q2w3e4r5t6y", "azertyuiop", "azertyuiop12", "asdfghjkl123",
  "administrator", "administrator1", "admin1234567", "admin123456", "adminadmin12", "superadmin123", "rootroot1234",
  "letmein12345", "letmein123456", "welcome12345", "welcome123456", "welcome2024", "welcome2025", "welcome2026",
  "iloveyou1234", "iloveyou12345", "changeme1234", "changeme12345", "trustno11234", "monkey123456", "dragon123456",
  "football1234", "baseball1234", "sunshine1234", "princess1234", "motdepasse12", "motdepasse123", "bonjour12345",
  "password2024", "password2025", "password2026", "emnaservices", "emnaservices1", "vitajobsearch", "trustcrm1234",
]);

const fold = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * @param {unknown} password
 * @param {string} [email]
 * @returns {string|null} reason when rejected, null when acceptable
 */
function checkPassword(password, email) {
  if (typeof password !== "string" || [...password].length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters long`;
  if (password.length > 200) return "Password must be at most 200 characters long";
  const folded = fold(password);
  if (COMMON.has(folded) || COMMON.has(password.toLowerCase())) return "Password is too common; choose a longer, unique passphrase";
  if (new Set(folded).size <= 2) return "Password is too common; choose a longer, unique passphrase";
  const local = typeof email === "string" && email.includes("@") ? email.slice(0, email.indexOf("@")).split("+")[0] : "";
  const localFolded = fold(local);
  if (localFolded.length >= 3 && folded.includes(localFolded)) return "Password must not contain the e-mail address (its part before @)";
  return null;
}

module.exports = { checkPassword, MIN_LENGTH };
