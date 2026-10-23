// Pre-flight check of a DOCX (zip) before anything is decompressed. Reads only the central
// directory. Sizes in headers can lie, so the extraction worker also has hard memory/time limits.
function limits() {
  const mb = Number(process.env.MAX_UNCOMPRESSED_MB);
  return {
    maxTotal: (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024,
    maxEntries: 1000,
    maxRatio: 100,
  };
}

/** @returns {null | string} a rejection reason, or null when the archive looks sane. */
function checkZip(buf) {
  const { maxTotal, maxEntries, maxRatio } = limits();
  if (buf.length < 22) return "not a valid archive";
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return "not a valid archive";
  const count = buf.readUInt16LE(eocd + 10);
  if (count > maxEntries) return "too many entries";
  let pos = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return "not a valid archive";
    total += buf.readUInt32LE(pos + 24);
    if (total > maxTotal) return "uncompressed size too large";
    pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  if (total > 1024 * 1024 && total / buf.length > maxRatio) return "compression ratio too high";
  return null;
}

module.exports = { checkZip };
