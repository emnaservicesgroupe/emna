// GET /chat/channels - honest channel status (stage 6, Task 3). Nothing here is optimistic:
//   in_app    connected (the messages live in VITA)
//   email     the mail adapter's own status; `sends_real_mail` is true only for a real provider that reports connected (the default sandbox
//             records mail locally and sends nothing)
//   whatsapp  always requires_setup in this build (needs the owner's provider account and approved templates)
const mail = require("../jobsearch/mail");
const whatsapp = require("./whatsapp");

async function channels() {
  let m;
  try {
    m = await mail.status();
  } catch (err) {
    m = { status: "requires_setup", detail: `mail status unavailable (${(err && (err.code || err.name)) || "error"})` };
  }
  const connected = m && m.status === "connected";
  const mode = (m && m.mode) || null;
  return {
    channels: [
      { channel: "in_app", status: "connected", detail: "Messages are stored and delivered inside VITA." },
      {
        channel: "email",
        status: connected ? "connected" : "requires_setup",
        mode,
        sends_real_mail: Boolean(connected && mode && mode !== "sandbox"),
        detail: String((m && m.detail) || (connected ? "connected" : "requires setup")),
      },
      whatsapp.status(),
    ],
  };
}

module.exports = { channels };
