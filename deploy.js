#!/usr/bin/env node
// GitHub 直推：github.com:443 不通时，用 Git Data API 把本地 HEAD 的内容同步上去
// 用法: node deploy.js
const { execFileSync } = require("child_process");

const REPO = "feijarvis/NCMCLI";
const BRANCH = "master";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
function token() {
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8",
  });
  const line = out.split("\n").find(l => l.startsWith("password="));
  if (!line) throw new Error("找不到 GitHub 凭据");
  return line.slice("password=".length).trim();
}
let TOKEN = null;
async function api(method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      "User-Agent": "ncm-cli",
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

(async () => {
  TOKEN = token();

  // 本地 HEAD 的完整文件清单（blob sha 由内容决定，跨仓库一致）
  const localFiles = new Map();
  for (const line of git("ls-tree", "-r", "HEAD").trim().split("\n").filter(Boolean)) {
    const [meta, ...rest] = line.split("\t");
    const path = rest.join("\t");
    const [mode, , sha] = meta.split(/\s+/);
    localFiles.set(path, { mode, sha });
  }

  let remoteSha = null, remoteTree = null, remoteFiles = new Map();
  try {
    const ref = await api("GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    remoteSha = ref.object.sha;
    const c = await api("GET", `/repos/${REPO}/git/commits/${remoteSha}`);
    remoteTree = c.tree.sha;
    const t = await api("GET", `/repos/${REPO}/git/trees/${remoteTree}?recursive=1`);
    for (const e of t.tree) if (e.type === "blob") remoteFiles.set(e.path, e.sha);
  } catch (e) {
    if (!/404/.test(e.message)) throw e;
  }

  // 内容比对
  const changed = [];
  for (const [p, f] of localFiles) if (remoteFiles.get(p) !== f.sha) changed.push({ path: p, del: false, ...f });
  for (const p of remoteFiles.keys()) if (!localFiles.has(p)) changed.push({ path: p, del: true });

  if (!changed.length) {
    console.log(`✓ 内容一致（远端 ${remoteSha.slice(0, 7)}，本地 ${git("rev-parse", "--short", "HEAD").trim()}）`);
    return;
  }
  console.log(`差异 ${changed.length} 个文件：${changed.map(c => (c.del ? "-" : "+") + c.path).join(", ")}`);

  const entries = [];
  for (const c of changed) {
    if (c.del) { entries.push({ path: c.path, mode: "100644", type: "blob", sha: null }); continue; }
    const buf = execFileSync("git", ["cat-file", "blob", c.sha], { maxBuffer: 128 * 1024 * 1024 });
    const blob = await api("POST", `/repos/${REPO}/git/blobs`, { content: buf.toString("base64"), encoding: "base64" });
    entries.push({ path: c.path, mode: c.mode, type: "blob", sha: blob.sha });
  }

  const tree = await api("POST", `/repos/${REPO}/git/trees`, { base_tree: remoteTree || undefined, tree: entries });

  const headMsg = git("log", "-1", "--format=%B", "HEAD");
  const [an, ae, ad] = git("log", "-1", "--format=%an%x00%ae%x00%aI", "HEAD").split("\0");
  const commit = await api("POST", `/repos/${REPO}/git/commits`, {
    message: headMsg.trim(),
    tree: tree.sha,
    parents: remoteSha ? [remoteSha] : [],
    author: { name: an, email: ae, date: ad },
    committer: { name: an, email: ae, date: ad },
  });

  if (remoteSha) {
    await api("PATCH", `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } else {
    await api("POST", `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
  console.log(`✓ GitHub ${BRANCH} → ${commit.sha.slice(0, 7)}（${headMsg.trim().split("\n")[0]}）`);
})().catch(e => { console.error("✗ " + e.message); process.exit(1); });
