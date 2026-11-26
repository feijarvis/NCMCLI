#!/usr/bin/env node
// 打包分发包：排除登录态与缓存
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const DIST = path.join(DIR, "dist");
const OUT = path.join(DIST, "ncm");
const KEEP = ["daemon.js", "ncm.js", "tui.js", "player.ps1", "install.js", "install.cmd", "audio-check.py"];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of KEEP) {
  const src = path.join(DIR, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, f));
}
// 自带便携 node.exe（朋友机器没装 Node 也能跑）
const nodeExe = process.execPath;
if (fs.existsSync(nodeExe)) fs.copyFileSync(nodeExe, path.join(OUT, "node.exe"));

const zip = path.join(DIST, "ncm.zip");
try {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -Force`], { stdio: "ignore" });
} catch (e) {
  console.error("压缩失败，已保留目录：", OUT);
}
const pages = ["cookie.txt", "tracks.json", "daemon.log"].filter(f => fs.existsSync(path.join(OUT, f)));
console.log(`已生成：${fs.existsSync(zip) ? zip : OUT}`);
console.log(`包含：${KEEP.join(", ")} + node.exe(${Math.round((fs.existsSync(path.join(OUT, "node.exe")) ? fs.statSync(path.join(OUT, "node.exe")).size : 0) / 1048576)}MB)`);
console.log(pages.length ? `警告：意外包含 ${pages.join(", ")}` : "已排除：cookie.txt / tracks.json / daemon.log（无登录态泄露）");
console.log("\n朋友那边：解压 → 双击 install.cmd → ncm login → ncm list");
