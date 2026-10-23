// Pluggable malware-scan hook. ClamAV (clamd INSTREAM over TCP) when CLAMAV_HOST is set;
// otherwise the honest answer is 'scan_unavailable' (never a silent "clean").
const net = require("net");

const CHUNK = 64 * 1024;

function timeoutMs() {
  const n = Number(process.env.CLAMAV_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

function clamdScan(buf, host, port) {
  return new Promise((resolve) => {
    let settled = false;
    let response = "";
    const socket = net.connect({ host, port });
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const unavailable = (why) => done({ status: "scan_unavailable", detail: `ClamAV unavailable: ${why}` });
    socket.setTimeout(timeoutMs(), () => unavailable("timeout"));
    socket.on("error", (err) => unavailable(err.code || err.message));
    socket.on("data", (d) => {
      response += d.toString("utf8");
    });
    socket.on("end", () => {
      const text = response.replace(/\0/g, "").trim();
      if (/OK$/.test(text)) return done({ status: "clean", detail: "ClamAV: OK" });
      const m = /^stream:\s*(.+?)\s+FOUND$/i.exec(text);
      if (m) return done({ status: "infected", detail: `ClamAV: ${m[1].slice(0, 120)}` });
      return unavailable("unexpected response");
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let off = 0; off < buf.length; off += CHUNK) {
        const part = buf.subarray(off, off + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

/** @returns {Promise<{status: 'clean'|'infected'|'scan_unavailable', detail: string}>} */
async function scan(buf) {
  const host = process.env.CLAMAV_HOST;
  if (!host) return { status: "scan_unavailable", detail: "No malware scanner configured (CLAMAV_HOST unset)" };
  const port = Number(process.env.CLAMAV_PORT) || 3310;
  return clamdScan(buf, host, port);
}

module.exports = { scan };
