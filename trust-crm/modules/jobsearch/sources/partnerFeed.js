// Generic partner feed (JSON or RSS) from admin-configured, approved URLs (PARTNER_FEED_URLS, comma separated).
const { SourceNotConnected } = require("./errors");
const { loadFeeds, filterJobs, configProblem } = require("./feedCommon");

const KEY = "partner_feed";
const urls = () => (process.env.PARTNER_FEED_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);

module.exports = {
  key: KEY,
  describe: () => ({ name: "Partner job feed", termsUrl: null, rateLimitPerMin: 2, requires: ["PARTNER_FEED_URLS"] }),
  status() {
    const u = urls();
    if (!u.length) return { status: "requires_setup", detail: "PARTNER_FEED_URLS is not set (approved partner feed URLs are required)" };
    const problem = configProblem(u);
    if (problem) return { status: "requires_setup", detail: `PARTNER_FEED_URLS rejected: ${problem}` };
    return { status: "connected", detail: `${u.length} approved feed(s) configured` };
  },
  async search(query, ctx = {}) {
    const st = this.status();
    if (st.status !== "connected") throw new SourceNotConnected(st.detail);
    return filterJobs(await loadFeeds(urls(), ctx, {}), query);
  },
  async fetchDetail(sourceJobId, ctx = {}) {
    const st = this.status();
    if (st.status !== "connected") throw new SourceNotConnected(st.detail);
    const all = await loadFeeds(urls(), ctx, {});
    return all.find((j) => j.sourceJobId === String(sourceJobId)) || null;
  },
};
