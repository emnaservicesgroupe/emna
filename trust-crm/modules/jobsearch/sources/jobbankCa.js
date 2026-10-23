// Job Bank (Canada) adapter. Official-feed only: nothing is fetched until the administrator
// supplies the authorized feed URL in JOBBANK_CA_FEED_URL. No scraping, no auth bypass.
const { SourceNotConnected } = require("./errors");
const { loadFeeds, filterJobs, configProblem } = require("./feedCommon");

const KEY = "jobbank_ca";
const urls = () => (process.env.JOBBANK_CA_FEED_URL ? [process.env.JOBBANK_CA_FEED_URL.trim()] : []);

module.exports = {
  key: KEY,
  describe: () => ({ name: "Job Bank (Canada) official feed", termsUrl: "https://www.jobbank.gc.ca/", rateLimitPerMin: 2, requires: ["JOBBANK_CA_FEED_URL"] }),
  status() {
    const u = urls();
    if (!u.length) return { status: "requires_setup", detail: "JOBBANK_CA_FEED_URL is not set (an authorized official feed URL is required)" };
    const problem = configProblem(u);
    if (problem) return { status: "requires_setup", detail: `JOBBANK_CA_FEED_URL rejected: ${problem}` };
    return { status: "connected", detail: "Authorized feed configured" };
  },
  async search(query, ctx = {}) {
    const st = this.status();
    if (st.status !== "connected") throw new SourceNotConnected(st.detail);
    return filterJobs(await loadFeeds(urls(), ctx, { country: "Canada" }), query);
  },
  async fetchDetail(sourceJobId, ctx = {}) {
    const st = this.status();
    if (st.status !== "connected") throw new SourceNotConnected(st.detail);
    const all = await loadFeeds(urls(), ctx, { country: "Canada" });
    return all.find((j) => j.sourceJobId === String(sourceJobId)) || null;
  },
};
