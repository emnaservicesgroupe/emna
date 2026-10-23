const path = require("path");
const { Worker } = require("worker_threads");
const { extract, sanitizeText, emptyExtraction } = require("./deterministic");
const { checkZip } = require("./zipguard");

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** reason: 'too_large' | 'timeout' | 'memory' | 'unreadable' */
class ExtractError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "ExtractError";
    this.reason = reason;
  }
}

function timeoutMs() {
  const n = Number(process.env.EXTRACT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

/** PDF/DOCX parsing runs in a worker thread with a memory cap and a hard timeout. */
function parseInWorker(buf, kind) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: { buf: new Uint8Array(buf), kind },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new ExtractError("timeout", "Document parsing timed out")), timeoutMs());
    worker.once("message", (m) => (m && m.ok ? finish(resolve, m.text) : finish(reject, new ExtractError("unreadable", "Document could not be parsed"))));
    worker.once("error", (err) =>
      finish(reject, err && err.code === "ERR_WORKER_OUT_OF_MEMORY" ? new ExtractError("memory", "Document too complex") : new ExtractError("unreadable", "Document could not be parsed"))
    );
    worker.once("exit", () => finish(reject, new ExtractError("unreadable", "Document could not be parsed")));
  });
}

/**
 * Extracts structured CV fields from file bytes. PDF via pdf-parse, DOCX via mammoth (both
 * isolated in a worker), text/plain for tests. Images have no text layer (no OCR): an empty
 * extraction is returned, never invented data. Throws ExtractError on unreadable/hostile files.
 */
async function extractFromFile(buf, mime) {
  let text;
  if (mime === PDF) text = await parseInWorker(buf, "pdf");
  else if (mime === DOCX) {
    const bad = checkZip(buf);
    if (bad) throw new ExtractError("too_large", `Document rejected: ${bad}`);
    text = await parseInWorker(buf, "docx");
  } else if (mime === "text/plain") text = buf.toString("utf8");
  else return emptyExtraction();
  return extract(sanitizeText(text));
}

module.exports = { extract, extractFromFile, ExtractError };
