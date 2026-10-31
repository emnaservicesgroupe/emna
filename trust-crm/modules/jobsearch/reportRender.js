// PDF and XLSX renderers for the report models built by reportExport.js. Pure: model in, bytes out. No database, no network.
//
//  * PDF (pdfkit, standard Helvetica): A4, tables that break across pages with the header row repeated, "Page i of n" on every page,
//    selectable text. The standard font draws Windows-1252 only: any other character (Arabic names, ...) is shown as the marker "[?]"
//    and the model carries the flag `pdf_non_latin_text` (the XLSX keeps the original text). A report requested in Arabic is drawn with
//    the English labels (flag `pdf_font_arabic_unavailable`); the XLSX carries the Arabic labels.
//  * XLSX (write-excel-file): one sheet per section, numbers are numeric cells, dates are real date cells holding the WALL-CLOCK
//    date of the report timezone (Excel has no zones), text cells that a spreadsheet could read as a formula get a leading apostrophe.
const { winAnsiOk } = require("./cvGenerator");
const { neutraliseFormula } = require("./exportService");

const METRIC_LABELS = {
  found: "Jobs found",
  matched: "Matches proposed",
  prepared: "Applications prepared",
  submitted: "Applications sent",
  confirmed: "Confirmed submitted",
  failed: "Failed",
  outcome_unknown: "Outcome unknown",
  replies: "Employer replies",
  interviews: "Interviews",
  offers: "Offers",
  rejections: "Rejections",
};
const METRIC_SHORT = { found: "Found", matched: "Matched", prepared: "Prepared", submitted: "Sent", confirmed: "Confirmed", failed: "Failed", outcome_unknown: "Unknown", replies: "Replies", interviews: "Interviews", offers: "Offers", rejections: "Rejected" };

const DISCLAIMER = {
  en: "This report documents activities performed. It does not guarantee a job offer, employer sponsorship, a work permit or a visa.",
  fr: "Ce rapport documente les activités réalisées. Il ne garantit ni une offre d'emploi, ni un parrainage par un employeur, ni un permis de travail, ni un visa.",
  ar: "يوثّق هذا التقرير الأنشطة التي تم تنفيذها. وهو لا يضمن الحصول على عرض عمل أو كفالة من صاحب العمل أو تصريح عمل أو تأشيرة.",
};

const LABELS = {
  en: {
    title: "Canada Job Search Activity Report",
    reference: "Candidate reference",
    candidate: "Candidate",
    period: "Reporting period",
    timezone: "Time zone",
    generated: "Generated",
    summary: "Summary of activities",
    cvVersions: "Canadian CV versions approved in the period",
    cvApproved: "Canadian CV approved (to date)",
    matches: "Job matches proposed",
    prepared: "Applications prepared",
    sent: "Applications sent (verified)",
    pending: "Applications pending (as of generation)",
    attention: "Submissions not delivered or awaiting verification",
    replies: "Employer replies",
    interviews: "Interviews",
    sentList: "Applications actually sent (verified)",
    sentNote: "Only applications that were sent to the employer are listed. Drafts, queued and failed applications are not.",
    employer: "Employer",
    position: "Position",
    dateSent: "Date sent",
    status: "Status",
    evidence: "Evidence reference",
    next: "Next planned actions",
    action: "Action",
    when: "Date / time",
    none: "None",
    yes: "Yes",
    no: "No",
    notice: "Important notice",
    notes: "Notes",
    sheetSummary: "Summary",
    sheetSent: "Applications sent",
    sheetNext: "Next actions",
    sheetNotes: "Notes",
    statuses: { sent: "Sent", confirmed_submitted: "Confirmed submitted" },
    actions: { queued: "Application queued for sending", approved: "Application approved, to be sent", interview_tentative: "Interview (tentative)", interview_confirmed: "Interview (confirmed)" },
    page: "Page",
    of: "of",
    noLatin: "Some text uses characters this PDF cannot show (marked [?]). The Excel version has the original text.",
    fallbackLang: "This PDF is in English because its font cannot draw Arabic. The Excel version is available in Arabic.",
  },
  fr: {
    title: "Rapport d'activité de recherche d'emploi au Canada",
    reference: "Référence du candidat",
    candidate: "Candidat",
    period: "Période couverte",
    timezone: "Fuseau horaire",
    generated: "Généré le",
    summary: "Résumé des activités",
    cvVersions: "Versions du CV canadien approuvées sur la période",
    cvApproved: "CV canadien approuvé (à ce jour)",
    matches: "Postes correspondants proposés",
    prepared: "Candidatures préparées",
    sent: "Candidatures envoyées (vérifiées)",
    pending: "Candidatures en attente (à la date de génération)",
    attention: "Envois non livrés ou en attente de vérification",
    replies: "Réponses d'employeurs",
    interviews: "Entretiens",
    sentList: "Candidatures réellement envoyées (vérifiées)",
    sentNote: "Seules les candidatures envoyées à l'employeur figurent ici. Les brouillons, les envois en file d'attente et les échecs n'y figurent pas.",
    employer: "Employeur",
    position: "Poste",
    dateSent: "Date d'envoi",
    status: "Statut",
    evidence: "Référence de preuve",
    next: "Prochaines actions prévues",
    action: "Action",
    when: "Date / heure",
    none: "Aucune",
    yes: "Oui",
    no: "Non",
    notice: "Avis important",
    notes: "Notes",
    sheetSummary: "Résumé",
    sheetSent: "Candidatures envoyées",
    sheetNext: "Prochaines actions",
    sheetNotes: "Notes",
    statuses: { sent: "Envoyée", confirmed_submitted: "Envoi confirmé" },
    actions: { queued: "Candidature en file d'envoi", approved: "Candidature approuvée, à envoyer", interview_tentative: "Entretien (provisoire)", interview_confirmed: "Entretien (confirmé)" },
    page: "Page",
    of: "sur",
    noLatin: "Certains textes utilisent des caractères que ce PDF ne peut pas afficher (marqués [?]). La version Excel contient le texte d'origine.",
    fallbackLang: "",
  },
  ar: {
    title: "تقرير نشاط البحث عن عمل في كندا",
    reference: "مرجع المرشح",
    candidate: "المرشح",
    period: "فترة التقرير",
    timezone: "المنطقة الزمنية",
    generated: "تاريخ الإنشاء",
    summary: "ملخص الأنشطة",
    cvVersions: "نسخ السيرة الذاتية الكندية المعتمدة خلال الفترة",
    cvApproved: "السيرة الذاتية الكندية معتمدة (حتى تاريخه)",
    matches: "الوظائف المقترحة",
    prepared: "الطلبات المُعدّة",
    sent: "الطلبات المرسلة (موثّقة)",
    pending: "الطلبات قيد الانتظار (وقت الإنشاء)",
    attention: "عمليات إرسال لم تُسلَّم أو بانتظار التحقق",
    replies: "ردود أصحاب العمل",
    interviews: "المقابلات",
    sentList: "الطلبات التي أُرسلت فعلاً (موثّقة)",
    sentNote: "تُدرج هنا فقط الطلبات التي أُرسلت إلى صاحب العمل. المسودات والطلبات في قائمة الإرسال والطلبات الفاشلة غير مدرجة.",
    employer: "صاحب العمل",
    position: "الوظيفة",
    dateSent: "تاريخ الإرسال",
    status: "الحالة",
    evidence: "مرجع الإثبات",
    next: "الإجراءات القادمة المخطط لها",
    action: "الإجراء",
    when: "التاريخ / الوقت",
    none: "لا يوجد",
    yes: "نعم",
    no: "لا",
    notice: "ملاحظة هامة",
    notes: "ملاحظات",
    sheetSummary: "الملخص",
    sheetSent: "الطلبات المرسلة",
    sheetNext: "الإجراءات القادمة",
    sheetNotes: "ملاحظات",
    statuses: { sent: "أُرسل", confirmed_submitted: "تم تأكيد الإرسال" },
    actions: { queued: "طلب في قائمة الإرسال", approved: "طلب معتمد بانتظار الإرسال", interview_tentative: "مقابلة (مبدئية)", interview_confirmed: "مقابلة (مؤكدة)" },
    page: "صفحة",
    of: "من",
    noLatin: "",
    fallbackLang: "",
  },
};

// ---------------------------------------------------------------- text helpers

const MAX_CELL = 2000;
const PDF_CELL = 200;

/** Control characters out (they would make the XML of a spreadsheet invalid), length capped with an ellipsis. */
function cleanText(v, max = MAX_CELL) {
  if (v === null || v === undefined) return "";
  let s = String(v).toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uFFFE\uFFFF]/g, "").replace(/[\t\r\n]+/g, " ");
  if (s.length > max) s = `${Array.from(s).slice(0, max - 1).join("")}…`;
  return s;
}

/** True when the standard PDF font cannot draw every character of the text. */
const needsLatinFallback = (s) => typeof s === "string" && s !== "" && !winAnsiOk(s);

/** Text for the PDF: every run of characters the standard font cannot draw becomes "[?]". */
function pdfText(v, max = PDF_CELL) {
  const s = cleanText(v, max);
  let out = "";
  let inRun = false;
  for (const ch of s) {
    if (winAnsiOk(ch)) {
      out += ch;
      inRun = false;
    } else if (!inRun) {
      out += "[?]";
      inRun = true;
    }
  }
  return out;
}

/** 'YYYY-MM-DD' (optionally ' HH:MM') of the report timezone -> a Date whose UTC fields are that wall-clock time. */
function wallClockDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(String(text));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)));
}

// ---------------------------------------------------------------- PDF

const MARGIN = 40;

function pdfDoc({ landscape = false, title, subject }) {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({
    size: "A4",
    layout: landscape ? "landscape" : "portrait",
    margins: { top: MARGIN, bottom: 50, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: pdfText(title), Subject: pdfText(subject || ""), Creator: "VITA", Producer: "VITA" },
  });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  return { doc, done };
}

const contentWidth = (doc) => doc.page.width - 2 * MARGIN;
const bottomLimit = (doc) => doc.page.height - 50;

function ensureSpace(doc, h) {
  if (doc.y + h > bottomLimit(doc)) doc.addPage();
}

function heading(doc, text, size = 12) {
  ensureSpace(doc, size + 30);
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(size).fillColor("#000000").text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  const y = doc.y + 1;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + contentWidth(doc), y).lineWidth(0.5).strokeColor("#000000").stroke();
  doc.moveDown(0.4);
}

function paragraph(doc, text, { size = 9, bold = false, gap = 0.2 } = {}) {
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000000");
  const h = doc.heightOfString(text, { width: contentWidth(doc) });
  ensureSpace(doc, h + 2);
  doc.text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(gap);
}

/**
 * Table with a repeated header row and page breaks between rows. `widths` are points; `align[i]` 'left' | 'right'.
 * Rows are arrays of already-prepared strings. `boldRows` = indexes of rows drawn bold (totals).
 */
function table(doc, { headers, widths, align = [], rows, boldRows = [], fontSize = 8.5 }) {
  const pad = 3;
  const x0 = MARGIN;
  const total = widths.reduce((a, b) => a + b, 0);
  const rowHeight = (cells, bold) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
    return Math.max(...cells.map((c, i) => doc.heightOfString(c || " ", { width: widths[i] - 2 * pad }))) + 2 * pad;
  };
  const drawRow = (cells, bold, fill) => {
    const h = rowHeight(cells, bold);
    if (doc.y + h > bottomLimit(doc)) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    if (fill) doc.rect(x0, y, total, h).fillColor("#eeeeee").fill();
    doc.fillColor("#000000").font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
    let x = x0;
    cells.forEach((c, i) => {
      doc.text(c, x + pad, y + pad, { width: widths[i] - 2 * pad, align: align[i] || "left", lineBreak: true });
      x += widths[i];
    });
    doc.moveTo(x0, y + h).lineTo(x0 + total, y + h).lineWidth(0.3).strokeColor("#999999").stroke();
    doc.x = MARGIN;
    doc.y = y + h;
  };
  const drawHeader = () => drawRow(headers, true, true);
  // keep the header with at least the first row
  const first = rows.length ? rowHeight(rows[0], false) : 0;
  ensureSpace(doc, rowHeight(headers, true) + first);
  drawHeader();
  rows.forEach((r, i) => drawRow(r, boldRows.includes(i), false));
  doc.x = MARGIN;
  doc.moveDown(0.3);
}

function headerBlock(doc, lines) {
  if (!lines || !lines.length) return;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000").text(pdfText(lines[0]), MARGIN, doc.y, { width: contentWidth(doc) });
  if (lines.length > 1) doc.font("Helvetica").fontSize(8.5).text(lines.slice(1).map((l) => pdfText(l)).join("  |  "), MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.6);
}

function pageNumbers(doc, label, L) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // otherwise text this low would add a page
    doc.font("Helvetica").fontSize(8).fillColor("#444444");
    doc.text(`${label}  -  ${L.page} ${i + 1} ${L.of} ${range.count}`, MARGIN, doc.page.height - 30, { width: contentWidth(doc), align: "center", lineBreak: false });
  }
}

function keyValueTable(doc, pairs) {
  const W = contentWidth(doc);
  const widths = [Math.round(W * 0.62), W - Math.round(W * 0.62)];
  const pad = 3;
  for (const [k, v] of pairs) {
    doc.font("Helvetica").fontSize(9.5);
    const h = Math.max(doc.heightOfString(k, { width: widths[0] - 2 * pad }), doc.heightOfString(v, { width: widths[1] - 2 * pad })) + 2 * pad;
    ensureSpace(doc, h);
    const y = doc.y;
    doc.fillColor("#000000").font("Helvetica").text(k, MARGIN + pad, y + pad, { width: widths[0] - 2 * pad });
    doc.font("Helvetica-Bold").text(v, MARGIN + widths[0] + pad, y + pad, { width: widths[1] - 2 * pad, align: "right" });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + W, y + h).lineWidth(0.3).strokeColor("#999999").stroke();
    doc.x = MARGIN;
    doc.y = y + h;
  }
}

/** Labels the PDF can draw: Arabic falls back to English (the standard font has no Arabic glyphs). */
const pdfLang = (model) => (model.lang === "ar" ? "en" : model.lang || "en");

async function renderCandidatePdf(model) {
  const lang = pdfLang(model);
  const L = LABELS[lang];
  const { doc, done } = pdfDoc({ title: L.title, subject: model.candidate.reference });
  headerBlock(doc, model.header);
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#000000").text(L.title, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.5);
  const a = model.activities;
  const yn = (b) => (b ? L.yes : L.no);
  keyValueTable(doc, [
    [L.reference, pdfText(model.candidate.reference || "-")],
    [L.candidate, pdfText(model.candidate.name || "-")],
    [L.period, `${model.period.from} - ${model.period.to}`],
    [L.timezone, pdfText(model.timezone)],
    [L.generated, `${model.generatedAtLocal} (${pdfText(model.timezone)})`],
  ]);
  heading(doc, L.summary);
  keyValueTable(doc, [
    [L.cvVersions, String(a.cvVersionsApproved)],
    [L.cvApproved, yn(a.cvApproved)],
    [L.matches, String(a.matchesProposed)],
    [L.prepared, String(a.applicationsPrepared)],
    [L.sent, String(a.applicationsSent)],
    [L.pending, String(a.applicationsPending)],
    [L.attention, String(a.needsAttention)],
    [L.replies, String(a.employerReplies)],
    [L.interviews, String(a.interviews)],
  ]);
  heading(doc, L.sentList);
  paragraph(doc, L.sentNote, { size: 8.5, gap: 0.4 });
  const W = contentWidth(doc);
  if (model.sent.length) {
    const widths = [24, Math.round(W * 0.27), Math.round(W * 0.27), 62, 0, 0];
    widths[4] = Math.round(W * 0.13);
    widths[5] = W - widths[0] - widths[1] - widths[2] - widths[3] - widths[4];
    table(doc, {
      headers: ["#", L.employer, L.position, L.dateSent, L.status, L.evidence],
      widths,
      rows: model.sent.map((s, i) => [String(i + 1), pdfText(s.employer || "-"), pdfText(s.position), s.date, L.statuses[s.status] || pdfText(s.status), pdfText(s.evidence || "-")]),
    });
  } else {
    paragraph(doc, L.none);
  }
  heading(doc, L.next);
  if (model.nextActions.length) {
    const widths = [Math.round(W * 0.32), Math.round(W * 0.26), 0, 100];
    widths[2] = W - widths[0] - widths[1] - widths[3];
    table(doc, {
      headers: [L.action, L.employer, L.position, L.when],
      widths,
      rows: model.nextActions.map((n) => [L.actions[n.type] || pdfText(n.type), pdfText(n.employer || "-"), pdfText(n.position || "-"), n.when || "-"]),
    });
  } else {
    paragraph(doc, L.none);
  }
  heading(doc, L.notice);
  paragraph(doc, DISCLAIMER[lang], { size: 10 });
  if (model.lang === "ar") paragraph(doc, LABELS.en.fallbackLang, { size: 8 });
  if (model.flags.includes("pdf_non_latin_text")) paragraph(doc, L.noLatin || LABELS.en.noLatin, { size: 8 });
  pageNumbers(doc, pdfText(`${model.candidate.reference || ""} ${L.title}`.trim(), 120), L);
  doc.end();
  return done;
}

async function renderCompanyPdf(model) {
  const L = LABELS.en;
  const title = "Company activity report";
  const { doc, done } = pdfDoc({ landscape: true, title, subject: `${model.period.from} - ${model.period.to}` });
  headerBlock(doc, model.header);
  doc.font("Helvetica-Bold").fontSize(17).fillColor("#000000").text(title, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.5);
  keyValueTable(doc, [
    ["Reporting period", `${model.period.from} - ${model.period.to}`],
    [L.timezone, pdfText(model.timezone)],
    ["Grouped by", model.groupBy === "period" ? `period (${model.bucket})` : model.groupBy],
    ["Scope", model.scope],
    [L.generated, `${model.generatedAtLocal} (${pdfText(model.timezone)})`],
  ]);
  heading(doc, "Activity");
  const W = contentWidth(doc);
  const metrics = model.metrics;
  const mw = 52;
  const first = W - mw * metrics.length;
  const rows = model.rows.map((r) => [pdfText(r.label ? `${r.label}` : r.key, 60), ...metrics.map((m) => String(r[m]))]);
  rows.push(["Total", ...metrics.map((m) => String(model.totals[m]))]);
  table(doc, {
    headers: [model.groupBy === "period" ? "Period start" : model.groupBy, ...metrics.map((m) => METRIC_SHORT[m])],
    widths: [first, ...metrics.map(() => mw)],
    align: ["left", ...metrics.map(() => "right")],
    rows,
    boldRows: [rows.length - 1],
  });
  paragraph(doc, "Counts are the number of recorded events in the period. A row with zeros means nothing was recorded.", { size: 8 });
  paragraph(doc, DISCLAIMER.en, { size: 8 });
  if (model.flags.includes("pdf_non_latin_text")) paragraph(doc, L.noLatin, { size: 8 });
  pageNumbers(doc, title, L);
  doc.end();
  return done;
}

async function renderPdf(model) {
  if (!model || typeof model !== "object") throw new Error("renderPdf: model required");
  if (model.type === "candidate_activity") return renderCandidatePdf(model);
  if (model.type === "company") return renderCompanyPdf(model);
  throw new Error("renderPdf: unknown model type");
}

// ---------------------------------------------------------------- XLSX

const text = (v) => {
  const s = neutraliseFormula(cleanText(v));
  return s === "" ? null : s;
};
const head = (v) => ({ value: cleanText(v), fontWeight: "bold", backgroundColor: "#EEEEEE" });
const num = (n) => ({ value: Number(n), type: Number });
const dateCell = (s, time = false) => {
  const d = wallClockDate(s);
  return d ? { value: d, type: Date, format: time ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd" } : text(s);
};

async function toXlsx(sheets) {
  const writeExcelFile = require("write-excel-file/node");
  const fn = writeExcelFile.default || writeExcelFile;
  return Buffer.from(await fn(sheets).toBuffer());
}

function headerLines(model, label) {
  return (model.header || []).map((l) => [label, text(l)]);
}

async function renderCandidateXlsx(model) {
  const L = LABELS[model.lang] || LABELS.en;
  const a = model.activities;
  const yn = (b) => (b ? L.yes : L.no);
  const summary = [
    [head(L.title), null],
    [text(L.reference), text(model.candidate.reference)],
    [text(L.candidate), text(model.candidate.name)],
    [text(L.period), text(`${model.period.from} - ${model.period.to}`)],
    [text(L.timezone), text(model.timezone)],
    [text(L.generated), dateCell(model.generatedAtLocal, true)],
    [null, null],
    [head(L.summary), null],
    [text(L.cvVersions), num(a.cvVersionsApproved)],
    [text(L.cvApproved), text(yn(a.cvApproved))],
    [text(L.matches), num(a.matchesProposed)],
    [text(L.prepared), num(a.applicationsPrepared)],
    [text(L.sent), num(a.applicationsSent)],
    [text(L.pending), num(a.applicationsPending)],
    [text(L.attention), num(a.needsAttention)],
    [text(L.replies), num(a.employerReplies)],
    [text(L.interviews), num(a.interviews)],
  ];
  const sent = [[L.employer, L.position, L.dateSent, L.status, L.evidence].map(head)];
  for (const s of model.sent) sent.push([text(s.employer), text(s.position), dateCell(s.date), text(L.statuses[s.status] || s.status), text(s.evidence)]);
  const next = [[L.action, L.employer, L.position, L.when].map(head)];
  for (const n of model.nextActions) next.push([text(L.actions[n.type] || n.type), text(n.employer), text(n.position), n.when ? dateCell(n.when, true) : null]);
  const notes = [[head(L.notice), null], [text(model.disclaimer), null], [null, null], [text(L.sentNote), null], ...headerLines(model, L.notes)];
  return toXlsx([
    { sheet: L.sheetSummary, data: summary, columns: [{ width: 52 }, { width: 34 }] },
    { sheet: L.sheetSent, data: sent, columns: [{ width: 34 }, { width: 34 }, { width: 14 }, { width: 22 }, { width: 24 }] },
    { sheet: L.sheetNext, data: next, columns: [{ width: 36 }, { width: 30 }, { width: 34 }, { width: 18 }] },
    { sheet: L.sheetNotes, data: notes, columns: [{ width: 120 }, { width: 10 }] },
  ]);
}

async function renderCompanyXlsx(model) {
  const metrics = model.metrics;
  const summary = [
    [head("Company activity report"), null],
    [text("Reporting period"), text(`${model.period.from} - ${model.period.to}`)],
    [text("Time zone"), text(model.timezone)],
    [text("Grouped by"), text(model.groupBy === "period" ? `period (${model.bucket})` : model.groupBy)],
    [text("Scope"), text(model.scope)],
    [text("Generated"), dateCell(model.generatedAtLocal, true)],
    [null, null],
    [head("Totals"), null],
    ...metrics.map((m) => [text(METRIC_LABELS[m]), num(model.totals[m])]),
  ];
  const isDay = model.groupBy === "period";
  const report = [[isDay ? "Period start" : model.groupBy, "Label", ...metrics.map((m) => METRIC_LABELS[m])].map(head)];
  for (const r of model.rows) report.push([isDay ? dateCell(r.key) : text(r.key), text(r.label), ...metrics.map((m) => num(r[m]))]);
  report.push([text("Total"), null, ...metrics.map((m) => num(model.totals[m]))]);
  const notes = [
    [text("Counts are the number of recorded events in the period. A row with zeros means nothing was recorded."), null],
    [text(DISCLAIMER.en), null],
    ...headerLines(model, "Company"),
  ];
  return toXlsx([
    { sheet: "Summary", data: summary, columns: [{ width: 34 }, { width: 40 }] },
    { sheet: "Report", data: report, columns: [{ width: 22 }, { width: 28 }, ...metrics.map(() => ({ width: 16 }))] },
    { sheet: "Notes", data: notes, columns: [{ width: 120 }, { width: 10 }] },
  ]);
}

async function renderXlsx(model) {
  if (!model || typeof model !== "object") throw new Error("renderXlsx: model required");
  if (model.type === "candidate_activity") return renderCandidateXlsx(model);
  if (model.type === "company") return renderCompanyXlsx(model);
  throw new Error("renderXlsx: unknown model type");
}

module.exports = { renderPdf, renderXlsx, LABELS, DISCLAIMER, METRIC_LABELS, cleanText, pdfText, needsLatinFallback, wallClockDate };
