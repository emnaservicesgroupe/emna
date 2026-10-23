const { extract, sanitizeText, emptyExtraction } = require("./deterministic");

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function pdfText(buf) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    return String(r.text || "")
      .split("\n")
      .filter((l) => !/^-- \d+ of \d+ --$/.test(l.trim()))
      .join("\n");
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function docxText(buf) {
  const mammoth = require("mammoth");
  const r = await mammoth.extractRawText({ buffer: buf });
  return String(r.value || "");
}

/**
 * Extracts structured CV fields from file bytes. PDF via pdf-parse, DOCX via mammoth,
 * text/plain for tests. Images have no text layer (no OCR): an empty extraction is
 * returned, never invented data. Throws on unreadable documents.
 */
async function extractFromFile(buf, mime) {
  let text;
  if (mime === PDF) text = await pdfText(buf);
  else if (mime === DOCX) text = await docxText(buf);
  else if (mime === "text/plain") text = buf.toString("utf8");
  else return emptyExtraction();
  return extract(sanitizeText(text));
}

module.exports = { extract, extractFromFile };
