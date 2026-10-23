// Runs PDF/DOCX text extraction in an isolated thread (resource-limited, killable).
const { parentPort, workerData } = require("worker_threads");

const MAX_PAGES = 30;
const MAX_CHARS = 600000;

function busyWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* simulates a parser that never yields (test hook only) */
  }
}

async function run({ buf, kind }) {
  if (process.env.NODE_ENV === "test" && Number(process.env.EXTRACT_TEST_DELAY_MS) > 0) busyWait(Number(process.env.EXTRACT_TEST_DELAY_MS));
  if (kind === "pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const r = await parser.getText({ first: MAX_PAGES });
      return String(r.text || "")
        .slice(0, MAX_CHARS)
        .split("\n")
        .filter((l) => !/^-- \d+ of \d+ --$/.test(l.trim()))
        .join("\n");
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  const mammoth = require("mammoth");
  const r = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  return String(r.value || "").slice(0, MAX_CHARS);
}

run(workerData)
  .then((text) => parentPort.postMessage({ ok: true, text }))
  .catch((err) => parentPort.postMessage({ ok: false, message: String((err && err.name) || "Error") }));
