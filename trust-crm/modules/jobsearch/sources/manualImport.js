// Staff-entered vacancies (paste/upload). Never searched; jobs arrive through POST /jobsearch/jobs/manual.
const KEY = "manual_import";

module.exports = {
  key: KEY,
  describe: () => ({ name: "Manual import (staff)", termsUrl: null, rateLimitPerMin: 0, requires: [] }),
  status: () => ({ status: "manual", detail: "Vacancies are entered by staff" }),
  async search() {
    return [];
  },
  /** Re-check reads back what staff stored; a manual vacancy is only closed by staff or its closing date. */
  async fetchDetail(sourceJobId) {
    const db = require("../../../db");
    const r = await db.query(
      `SELECT s.source_job_id, j.url, j.title, e.name AS employer, j.location, j.country, j.published_at, j.closing_at, j.description_text
         FROM js_job_sightings s JOIN js_sources src ON src.id = s.source_id AND src.key = $2
         JOIN js_jobs j ON j.id = s.job_id LEFT JOIN js_employers e ON e.id = j.employer_id
        WHERE s.source_job_id = $1`,
      [String(sourceJobId), KEY]
    );
    if (!r.rowCount) return null;
    const j = r.rows[0];
    return { sourceJobId: j.source_job_id, url: j.url, title: j.title, employerName: j.employer, location: j.location, country: j.country, publishedAt: j.published_at, closingAt: j.closing_at, description: j.description_text, language: null };
  },
};
