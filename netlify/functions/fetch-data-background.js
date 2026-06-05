const { getStore } = require("@netlify/blobs");

// Import the scraper – wrap in try/catch in case the file is missing
let scrapeAllWeeks;
try {
  const scraper = require("./common/scraper");
  scrapeAllWeeks = scraper.scrapeAllWeeks;
} catch (err) {
  console.error("Failed to load scraper:", err);
  // Provide a dummy function that returns an error result
  scrapeAllWeeks = async () => ({
    records: [],
    logs: ["Scraper module not found. Check file path: netlify/functions/common/scraper.js"],
    lastFridayUrl: null,
    lastFridayIso: null
  });
}

exports.handler = async (event) => {
  // Generate a unique job ID
  const jobId = Date.now() + "-" + Math.random().toString(36).substring(2, 8);
  
  try {
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

    // Kick off async processing (don't await – background)
    (async () => {
      try {
        console.log(`Job ${jobId}: Starting scrape...`);
        const result = await scrapeAllWeeks();
        console.log(`Job ${jobId}: Scrape completed, ${result.records?.length || 0} records.`);
        await store.set(jobId, JSON.stringify({
          status: "completed",
          ...result,
          updatedAt: new Date().toISOString()
        }));
      } catch (err) {
        console.error(`Job ${jobId} failed:`, err);
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
      body: JSON.stringify({ jobId, message: "Job started" })
    };
  } catch (err) {
    console.error("Failed to start job:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message })
    };
  }
};