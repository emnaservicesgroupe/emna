// Mail adapter facade. Provider chosen per call from MAIL_PROVIDER (default "sandbox").
const sandbox = require("./sandbox");
const imapSmtp = require("./imapSmtp");

function provider() {
  const name = String(process.env.MAIL_PROVIDER || "sandbox").toLowerCase();
  return name === "imap_smtp" || name === "imapsmtp" ? imapSmtp : sandbox;
}

module.exports = {
  status: (...a) => provider().status(...a),
  send: (...a) => provider().send(...a),
  poll: (...a) => provider().poll(...a),
  sandbox, // test helpers: injectInbound(), listOutbound()
  imapSmtp,
};
