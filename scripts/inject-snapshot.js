const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function formatNumber(value, decimals = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDate(value) {
  if (!DATE_ONLY.test(String(value || ""))) throw new Error(`invalid snapshot date: ${value}`);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

function replaceElementText(html, id, text) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(<[^>]*\\bid="${escapedId}"[^>]*>)[^<]*(</[^>]+>)`);
  if (!pattern.test(html)) throw new Error(`snapshot target #${id} is missing or not a text-only element`);
  return html.replace(pattern, (_, open, close) => `${open}${text}${close}`);
}

function injectSnapshot(html, rbiDataText) {
  const data = JSON.parse(rbiDataText);
  if (!Array.isArray(data.records) || data.records.length === 0) throw new Error("RBI snapshot has no records");
  const records = data.records.filter(row => row && DATE_ONLY.test(String(row.date || ""))).sort((a, b) => a.date.localeCompare(b.date));
  const latest = records.at(-1);
  if (!latest) throw new Error("RBI snapshot contains no dated records");

  const generatedAt = data.data_updated_at || data.fetched_at || null;
  const generated = generatedAt && new Date(generatedAt);
  const generatedText = generated && !Number.isNaN(generated.getTime())
    ? `${generated.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`
    : "generation time unavailable";
  const dateText = formatDate(latest.date);
  const snapshot = {
    fetched_at: generatedAt,
    date_modified: data.date_modified || generatedAt?.slice(0, 10) || null,
    temporal_coverage: data.temporal_coverage || `${records[0].date}/${latest.date}`,
    latest: {
      date: latest.date,
      total_usd: latest.total_usd ?? null,
      gold_usd: latest.gold_usd ?? null,
      usd_inr: latest.usd_inr ?? null,
      nifty: latest.nifty ?? null,
      sensex: latest.sensex ?? null,
    },
  };

  let output = html;
  const jsonPattern = /(<script\b[^>]*\bid="seo-data-snapshot"[^>]*>)[\s\S]*?(<\/script>)/;
  if (!jsonPattern.test(output)) throw new Error("#seo-data-snapshot script is missing");
  output = output.replace(jsonPattern, (_, open, close) => `${open}${JSON.stringify(snapshot)}${close}`);

  const schemaPattern = /(<script\b[^>]*\bid="seo-dataset-schema"[^>]*>)([\s\S]*?)(<\/script>)/;
  const schemaMatch = schemaPattern.exec(output);
  if (!schemaMatch) throw new Error("#seo-dataset-schema script is missing");
  const schema = JSON.parse(schemaMatch[2]);
  const dataset = schema["@graph"]?.find(item => item["@type"] === "Dataset");
  if (!dataset) throw new Error("Dataset JSON-LD node is missing");
  if (snapshot.date_modified) dataset.dateModified = snapshot.date_modified;
  if (snapshot.temporal_coverage) dataset.temporalCoverage = snapshot.temporal_coverage;
  output = output.replace(schemaPattern, (_, open, _body, close) => `${open}\n${JSON.stringify(schema, null, 2)}\n${close}`);

  for (const [id, value] of Object.entries({
    "snapshot-observation": dateText,
    "snapshot-generated": generatedText,
    "snapshot-reserves": formatNumber(latest.total_usd),
    "snapshot-gold": formatNumber(latest.gold_usd),
    "snapshot-usdinr": formatNumber(latest.usd_inr, 2),
    "snapshot-nifty": formatNumber(latest.nifty, 1),
    "snapshot-sensex": formatNumber(latest.sensex, 1),
    "snapshot-vintage": `Latest committed static RBI WSS observation: week ended ${dateText}. Snapshot generated ${generatedText}. Other series may use different source dates.`,
    "weekly-summary-text": `Latest WSS observation, week ended ${dateText}: foreign-exchange reserves were USD ${formatNumber(latest.total_usd)} million and gold holdings were USD ${formatNumber(latest.gold_usd)} million. The dashboard displays each observation with its reporting date; other series may have separate source dates.`,
    "snapshot-date-res": dateText,
    "snapshot-date-gold": dateText,
    "snapshot-date-fx": dateText,
    "snapshot-date-nifty": dateText,
    "snapshot-date-sensex": dateText,
    "m-res-usd": formatNumber(latest.total_usd),
    "m-gold-usd": formatNumber(latest.gold_usd),
    "m-usd-inr": formatNumber(latest.usd_inr, 2),
    "m-nifty": formatNumber(latest.nifty, 1),
    "m-sensex": formatNumber(latest.sensex, 1),
  })) output = replaceElementText(output, id, value);

  return output;
}

module.exports = { injectSnapshot, formatDate, formatNumber };
