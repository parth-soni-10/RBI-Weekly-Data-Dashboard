const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing jobId" })
    };
  }

  const store = getStore("rbi-dashboard-jobs");
  const data = await store.get(jobId);
  if (!data) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Job not found" })
    };
  }

  const job = JSON.parse(data);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job)
  };
};