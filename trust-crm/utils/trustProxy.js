// Opt-in Express "trust proxy" from TRUST_PROXY (unset = Express default: req.ip is the socket peer).
// Behind an HTTPS reverse proxy every request otherwise appears to come from the proxy's address,
// so the per-IP rate limits (OTP, inbound webhook) would be shared by all clients.
//   TRUST_PROXY=1                      number of proxy hops in front of the app (typical: 1)
//   TRUST_PROXY=loopback               Express names / IPs / CIDRs, comma separated (e.g. "loopback,10.0.0.0/8")
// "true"/"yes"/"*" are refused: trusting every hop lets any client spoof X-Forwarded-For.
function trustProxySetting(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  if (!v || /^(false|0|off|no)$/i.test(v)) return null;
  if (/^(true|yes|on|\*)$/i.test(v)) throw new Error("TRUST_PROXY must be a hop count or an address list, not 'true' (that would trust a spoofed X-Forwarded-For)");
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

module.exports = { trustProxySetting };
