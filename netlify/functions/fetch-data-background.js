const { getStore } = require("@netlify/blobs");
const { scrapeAllWeeks } = require("./common/scraper"); // we'll create this

exports.handler = async (event) => {
  // Generate a unique job ID
  const jobId = Date.now() + "-" + Math.random().toString(36).substring(2, 8);
  const store = getStore("rbi-dashboard-jobs");

  // Store initial status
  await store.set(jobId, JSON.stringify({
    status: "running",
    records: [],
    logs: [],
    lastFridayUrl: null,
    lastFridayIso: null,
    updatedAt: new Date().toISOString()
  }));

  // Kick off async processing (don't await)
  (async () => {
    try {
      const result = await scrapeAllWeeks(); // returns { records, logs, lastFridayUrl, lastFridayIso }
      await store.set(jobId, JSON.stringify({
        status: "completed",
        ...result,
        updatedAt: new Date().toISOString()
      }));
    } catch (err) {
      console.error("Job failed:", err);
      await store.set(jobId, JSON.stringify({
        status: "error",
        error: err.message,
        records: [],
        logs: [],
        updatedAt: new Date().toISOString()
      }));
    }
  })();

  // Return job ID immediately
  return {
    statusCode: 202,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, message: "Job started. Poll /api/status?jobId=..." })
  };
};