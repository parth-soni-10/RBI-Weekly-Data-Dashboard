// Import the scraper – wrap in try/catch
let scrapeAllWeeks;
try {
  const scraper = require("./common/scraper");
  scrapeAllWeeks = scraper.scrapeAllWeeks;
} catch (err) {
  console.error("Failed to load scraper:", err);
  scrapeAllWeeks = async () => ({
    records: [],
    logs: ["Scraper module not found. Check file path: netlify/functions/common/scraper.js"],
    lastFridayUrl: null,
    lastFridayIso: null
  });
}

exports.handler = async (event) => {
  const jobId = Date.now() + "-" + Math.random().toString(36).substring(2, 8);
  
  try {
    // Netlify's global store (available in production)
    const store = Netlify.store;
    
    await store.set(`job-${jobId}`, JSON.stringify({
      status: "running",
      records: [],
      logs: [],
      lastFridayUrl: null,
      lastFridayIso: null,
      updatedAt: new Date().toISOString()
    }));

    // Kick off async processing (background)
    (async () => {
      try {
        console.log(`Job ${jobId}: Starting scrape...`);
        const result = await scrapeAllWeeks();
        console.log(`Job ${jobId}: Scrape completed, ${result.records?.length || 0} records.`);
        await store.set(`job-${jobId}`, JSON.stringify({
          status: "completed",
          ...result,
          updatedAt: new Date().toISOString()
        }));
      } catch (err) {
        console.error(`Job ${jobId} failed:`, err);
        await store.set(`job-${jobId}`, JSON.stringify({
          status: "error",
          error: err.message,
          records: [],
          logs: [],
          updatedAt: new Date().toISOString()
        }));
      }
    })();

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