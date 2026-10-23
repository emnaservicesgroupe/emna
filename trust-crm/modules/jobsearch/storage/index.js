const crypto = require("crypto");
const local = require("./local");

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME).map(([ext, mime]) => [mime, ext]));

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function maxBytes() {
  const mb = Number(process.env.MAX_UPLOAD_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 10) * 1024 * 1024;
}

/** Lists entry names of a zip via its central directory; null if not a readable zip. */
function zipEntryNames(buf) {
  if (buf.length < 22) return null;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    if (pos + 46 + nameLen > buf.length) return null;
    names.push(buf.toString("utf8", pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Determines the MIME type from content only. Throws for anything but PDF, DOCX, PNG, JPEG. */
function sniffMime(buf) {
  if (Buffer.isBuffer(buf) && buf.length >= 8) {
    if (buf.toString("latin1", 0, 5) === "%PDF-") return MIME.pdf;
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return MIME.png;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return MIME.jpg;
    if (buf.readUInt32LE(0) === 0x04034b50) {
      const names = zipEntryNames(buf);
      if (names && names.some((n) => n.startsWith("word/"))) return MIME.docx;
    }
  }
  throw fail("Unsupported file type: only PDF, DOCX, PNG and JPEG are allowed", "UNSUPPORTED_TYPE");
}

/** meta.name and meta.mime are never trusted and never used for the storage key. */
async function put(buf, meta = {}) {
  if (!Buffer.isBuffer(buf)) throw fail("Upload must be a Buffer", "INVALID_UPLOAD");
  if (buf.length > maxBytes()) throw fail("File too large", "FILE_TOO_LARGE");
  const candidateId = Number(meta.candidateId);
  if (!Number.isInteger(candidateId) || candidateId <= 0) throw fail("candidateId required", "INVALID_UPLOAD");
  const mime = sniffMime(buf);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const key = `${candidateId}-${sha256}.${EXT_BY_MIME[mime]}`;
  await local.put(key, buf);
  return { key, sha256, size: buf.length, mime };
}

const get = (key) => local.get(key);
const del = (key) => local.remove(key);

function secret() {
  const s = process.env.STORAGE_URL_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "test") return "test-only-storage-url-secret";
  return null;
}

function mac(s, key, userId, exp) {
  return crypto.createHmac("sha256", s).update(`${key}\n${userId}\n${exp}`).digest("hex");
}

function signUrl(key, userId, ttlSec = 300) {
  local.assertKey(key);
  const s = secret();
  if (!s) throw new Error("STORAGE_URL_SECRET is not set; refusing to sign storage URLs");
  const exp = Math.floor(Date.now() / 1000) + Math.floor(ttlSec);
  return `/jobsearch/files/${encodeURIComponent(key)}?u=${encodeURIComponent(userId)}&exp=${exp}&sig=${mac(s, key, userId, exp)}`;
}

function verifyUrl(url) {
  try {
    const s = secret();
    if (!s || typeof url !== "string") return null;
    const u = new URL(url, "http://local.invalid");
    const m = /^\/jobsearch\/files\/([^/]+)$/.exec(u.pathname);
    if (!m) return null;
    const key = decodeURIComponent(m[1]);
    const userId = u.searchParams.get("u");
    const exp = u.searchParams.get("exp");
    const sig = u.searchParams.get("sig") || "";
    if (!userId || !/^\d+$/.test(userId) || !/^\d+$/.test(exp || "")) return null;
    local.assertKey(key);
    const want = Buffer.from(mac(s, key, userId, exp));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
    return { key, userId: Number(userId) };
  } catch {
    return null;
  }
}

module.exports = { put, get, delete: del, signUrl, verifyUrl, sniffMime };
