#!/usr/bin/env node
// 一键发布：提交 → 推 Codeup → 推 GitHub(API)
// 用法: node publish.js "提交说明"
const path = require("path");
const { execFileSync } = require("child_process");

const msg = process.argv.slice(2).join(" ").trim();
const DIR = __dirname;
const git = (...a) => execFileSync("git", a, { cwd: DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

try {
  git("add", "-A");
  let dirty = false;
  try { git("diff", "--cached", "--quiet"); } catch { dirty = true; }

  if (dirty) {
    if (!msg) { console.error("✗ 有改动，请提供提交说明：node publish.js \"说明\""); process.exit(1); }
    git("commit", "-m", msg);
    console.log("✓ 本地提交：" + msg);
  } else {
    console.log("· 无本地改动");
  }

  console.log("→ Codeup");
  execFileSync("git", ["push", "origin", "master"], { cwd: DIR, stdio: "inherit" });

  console.log("→ GitHub（Git Data API）");
  execFileSync(process.execPath, [path.join(DIR, "deploy.js")], { cwd: DIR, stdio: "inherit" });
} catch (e) {
  console.error("✗ 发布失败：" + (e.message || e));
  process.exit(1);
}
