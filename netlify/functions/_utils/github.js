// _utils/github.js — the repository side of the scheduled refresh.
//
// The scheduled Worker (worker.js `scheduled` → netlify/functions/refresh-data.js)
// has no filesystem, so both halves of a refresh go over the GitHub API:
//
//   read    GET /repos/{repo}/contents/{path}?ref={branch} — the committed file
//           plus its blob sha. The text is what the incremental scrapers treat as
//           "what we already have"; a 404 is not an error, it means no file yet.
//
//   commit  the Git Data API — blob per file, then one tree, then ONE commit,
//           then a fast-forward ref update. A run that changes four files lands
//           as a single commit, which is what the GitHub Action's
//           `git add ... && git commit` did, and therefore one Workers Builds
//           deploy rather than four.
//
// The ref update can lose a race with any other push to the branch; GitHub
// reports that as a 422 (a plain `git push` would say non-fast-forward). The
// sequence is replayed once against the new head — the same retry the Action's
// `git pull --rebase origin main && git push` performed — so a concurrent manual
// commit costs a retry, not the refresh. `force` is never set: a refresh that
// cannot fast-forward fails loudly instead of rewriting history.
//
// Nothing here is reachable over HTTP. There is no route for it in worker.js, so
// the only caller is the cron and the only credential is the Worker secret.
//
//   makeGitHubIo({ token, repo, branch }) → { read(path), commit({ files, message }) }

const UA = "rbi-weekly-dashboard-refresh";
const API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 20000;

function encode(text) {
  return Buffer.from(String(text), "utf8").toString("base64");
}

function decode(content) {
  // The Contents API wraps base64 at 60 characters; Buffer ignores the newlines.
  return Buffer.from(String(content || ""), "base64").toString("utf8");
}

/** One line naming what went wrong, with GitHub's own message when there is one. */
function describe(res) {
  if (res.error) return res.error;
  let detail = "";
  try {
    if (res.json && res.json.message) detail = res.json.message;
    else detail = String(res.text || "").slice(0, 200);
  } catch (_) { /* nothing readable came back */ }
  return `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

function makeGitHubIo({ token, repo, branch = "main", fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!token || !repo) throw new Error("makeGitHubIo needs a token and an owner/repo");

  async function api(method, path, body) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(API + path, {
        method,
        signal: ctrl.signal,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": UA,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error page */ }
      return { ok: res.ok, status: res.status, json, text };
    } catch (e) {
      return { ok: false, status: 0, json: null, text: "", error: String((e && e.message) || e) };
    } finally {
      clearTimeout(tid);
    }
  }

  /** The committed text of one file, or { ok: true, text: null } when it is not there yet. */
  async function read(path) {
    const res = await api("GET", `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) return { ok: true, text: null, sha: null };
    if (!res.ok) return { ok: false, text: null, error: describe(res) };
    if (!res.json || typeof res.json.content !== "string") {
      return { ok: false, text: null, error: `no file content came back for ${path}` };
    }
    return { ok: true, text: decode(res.json.content), sha: res.json.sha };
  }

  async function readHead() {
    const ref = await api("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!ref.ok) return { ok: false, error: describe(ref) };
    const head = ref.json && ref.json.object && ref.json.object.sha;
    if (!head) return { ok: false, error: "could not read the branch head" };
    const commit = await api("GET", `/repos/${repo}/git/commits/${head}`);
    if (!commit.ok) return { ok: false, error: describe(commit) };
    const baseTree = commit.json && commit.json.tree && commit.json.tree.sha;
    if (!baseTree) return { ok: false, error: "could not read the head commit's tree" };
    return { ok: true, head, baseTree };
  }

  async function commitOnce({ files, message }) {
    const head = await readHead();
    if (!head.ok) return { ok: false, error: head.error, retryable: false };

    const tree = [];
    for (const file of files) {
      const blob = await api("POST", `/repos/${repo}/git/blobs`, { content: file.content, encoding: "utf-8" });
      if (!blob.ok) return { ok: false, error: `${file.path}: ${describe(blob)}`, retryable: false };
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.json.sha });
    }

    const newTree = await api("POST", `/repos/${repo}/git/trees`, { base_tree: head.baseTree, tree });
    if (!newTree.ok) return { ok: false, error: `tree: ${describe(newTree)}`, retryable: false };

    const made = await api("POST", `/repos/${repo}/git/commits`, { message, tree: newTree.json.sha, parents: [head.head] });
    if (!made.ok) return { ok: false, error: `commit: ${describe(made)}`, retryable: false };

    const moved = await api("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: made.json.sha,
      force: false,
    });
    if (!moved.ok) {
      // 422/409 here is the branch having moved under us — replay once.
      return {
        ok: false,
        error: `ref: ${describe(moved)}`,
        retryable: moved.status === 422 || moved.status === 409,
      };
    }
    return { ok: true, commit: made.json.sha, url: made.json.html_url, files: files.length };
  }

  /** One commit for every file, retried once on a ref race. */
  async function commit({ files, message, attempts = 2 }) {
    if (!files || !files.length) return { ok: true, skipped: true, files: 0 };
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res = await commitOnce({ files, message });
      if (res.ok) return { ...res, attempts: attempt };
      last = { ...res, attempts: attempt };
      if (!res.retryable) break;
    }
    return last;
  }

  return { read, commit, repo, branch };
}

module.exports = { makeGitHubIo, encode, decode, describe };
