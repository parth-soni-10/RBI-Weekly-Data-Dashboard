(async () => {
  try {
    // No `cache: "no-store"` override - let the server-side Cache-Control: max-age=900
    // header do the work so the embed doesn't burn a Netlify invocation each load.
    const res = await fetch("/data/latest.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const r = data.record || {};
    const total = r.total_usd;
    const fca   = r.fca_usd ?? (total && r.gold_usd ? total - (r.gold_usd||0) - (r.sdr_usd||0) - (r.imf_reserve_usd||0) : null);
    const parts = [
      { label: "Foreign Currency Assets", value: fca,                          color: "#16a34a" },
      { label: "Gold",                    value: r.gold_usd          || null,   color: "#eab308" },
      { label: "SDR",                     value: r.sdr_usd           || null,   color: "#2563eb" },
      { label: "IMF Reserve",             value: r.imf_reserve_usd   || null,   color: "#dc2626" },
    ].filter(p => p.value != null && p.value > 0);

    document.getElementById("val").textContent =
      total ? total.toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " USD mn" : "-";
    document.getElementById("sub").textContent = "As of " + (data.iso || r.date || "-");

    if (!parts.length) throw new Error("no breakdown available");

    new Chart(document.getElementById("c"), {
      type: "doughnut",
      data: { labels: parts.map(p => p.label), datasets: [{ data: parts.map(p => p.value), backgroundColor: parts.map(p => p.color), borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { font: { size: 10.5 }, boxWidth: 10, color: "#14532d" } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toLocaleString("en-IN")} USD mn` } } }, cutout: "60%" }
    });
  } catch (e) {
    document.getElementById("val").textContent = "-";
    document.getElementById("sub").textContent = "Unavailable";
    const err = document.getElementById("err");
    err.textContent = "Could not load latest data: " + e.message + " Please check back in a moment or refresh the page.";
    err.hidden = false;
  }
})();
