const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

process.env.NODE_ENV = "test";
process.env.STORAGE_URL_SECRET = "unit-test-secret";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vita-store-"));
process.env.STORAGE_DIR = dir;
const storage = require("../modules/jobsearch/storage");

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("hello")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);

function crc32(buf) {
  return zlib.crc32 ? zlib.crc32(buf) : 0;
}
function zip(names) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(n.length, 26);
    const local = Buffer.concat([lh, n]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc32(Buffer.alloc(0)), 16);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, n]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("sniffMime accepts only PDF, DOCX, PNG, JPEG", () => {
  assert.equal(storage.sniffMime(PDF), "application/pdf");
  assert.equal(storage.sniffMime(PNG), "image/png");
  assert.equal(storage.sniffMime(JPG), "image/jpeg");
  assert.equal(
    storage.sniffMime(zip(["[Content_Types].xml", "word/document.xml"])),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  assert.throws(() => storage.sniffMime(zip(["xl/workbook.xml"])), /unsupported/i);
  assert.throws(() => storage.sniffMime(EXE), /unsupported/i);
  assert.throws(() => storage.sniffMime(Buffer.alloc(0)), /unsupported/i);
});

test("file named .pdf with EXE magic bytes is rejected", async () => {
  await assert.rejects(
    storage.put(EXE, { candidateId: 1, name: "cv.pdf", mime: "application/pdf" }),
    /unsupported/i
  );
});

test("oversized upload rejected", async () => {
  process.env.MAX_UPLOAD_MB = "1";
  try {
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(1024 * 1024 + 1)]);
    await assert.rejects(storage.put(big, { candidateId: 1, name: "a.pdf" }), /too large|exceeds/i);
  } finally {
    delete process.env.MAX_UPLOAD_MB;
  }
});

test("key derives from content hash, not filename; round trip and delete", async () => {
  const r = await storage.put(PDF, { candidateId: 7, name: "../../etc/passwd.pdf", mime: "application/pdf" });
  assert.equal(r.size, PDF.length);
  assert.match(r.sha256, /^[a-f0-9]{64}$/);
  assert.ok(r.key.includes(r.sha256));
  assert.ok(!r.key.includes("passwd") && !r.key.includes(".."));
  assert.deepEqual(await storage.get(r.key), PDF);
  assert.ok(fs.readdirSync(dir).length >= 1);
  await storage.delete(r.key);
  await assert.rejects(storage.get(r.key));
});

test("path traversal keys are rejected", async () => {
  for (const k of ["../x", "/etc/passwd", "a/../../b", "..\\x", "7-abc.pdf", "", null]) {
    await assert.rejects(storage.get(k), /invalid/i);
    await assert.rejects(storage.delete(k), /invalid/i);
  }
});

test("signed URL verifies; tampered and expired return null", async () => {
  const r = await storage.put(PNG, { candidateId: 3, name: "p.png" });
  const url = storage.signUrl(r.key, 42, 300);
  assert.deepEqual(storage.verifyUrl(url), { key: r.key, userId: 42 });
  assert.equal(storage.verifyUrl(url.replace("u=42", "u=43")), null);
  assert.equal(storage.verifyUrl(url.slice(0, -1) + (url.endsWith("0") ? "1" : "0")), null);
  assert.equal(storage.verifyUrl("garbage"), null);
  const expired = storage.signUrl(r.key, 42, -10);
  assert.equal(storage.verifyUrl(expired), null);
  await storage.delete(r.key);
});

test("signUrl throws without secret outside test env", () => {
  const savedSecret = process.env.STORAGE_URL_SECRET;
  const savedEnv = process.env.NODE_ENV;
  delete process.env.STORAGE_URL_SECRET;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => storage.signUrl("1-" + "a".repeat(64) + ".pdf", 1), /STORAGE_URL_SECRET/);
    assert.equal(storage.verifyUrl("/x?u=1&exp=9999999999&sig=aa"), null);
  } finally {
    process.env.STORAGE_URL_SECRET = savedSecret;
    process.env.NODE_ENV = savedEnv;
  }
});
