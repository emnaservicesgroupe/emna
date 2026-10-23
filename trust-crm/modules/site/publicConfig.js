// Non-secret site facts for the public website. Only values that are actually set are returned;
// nothing is ever invented (hidden-until-set rule).
const FACTS = [
  ["phone", "SITE_PHONE"],
  ["whatsapp", "SITE_WHATSAPP"],
  ["email", "SITE_EMAIL"],
  ["address", "SITE_ADDRESS"],
  ["licence", "SITE_LICENCE_TEXT"],
];

function getPublicConfig(env = process.env) {
  const name = typeof env.SITE_NAME === "string" && env.SITE_NAME.trim() ? env.SITE_NAME.trim() : "VITA";
  const out = { name };
  for (const [key, envKey] of FACTS) {
    const v = env[envKey];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

module.exports = { getPublicConfig };
