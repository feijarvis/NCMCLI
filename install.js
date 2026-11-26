#!/usr/bin/env node
// ncm 安装器：检查依赖 + 生成命令入口
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const args = process.argv.slice(2);
const binArg = args.indexOf("--bin");
const BIN = binArg >= 0 ? args[binArg + 1] : path.join(os.homedir(), "bin");

const line = s => console.log(s);
const ok = s => console.log("  \u2713 " + s);
const bad = s => console.log("  \u2717 " + s);

line("ncm 安装\n" + "=".repeat(40));

/* 1. Node.js */
const major = parseInt(process.versions.node, 10);
if (major < 18) {
  bad(`Node.js ${process.versions.node} 太旧，需要 >= 18（https://nodejs.org）`);
  process.exit(1);
}
ok(`Node.js ${process.versions.node}`);

/* 2. curl（Win10 1803+ 自带） */
try {
  execFileSync("curl", ["--version"], { stdio: "ignore" });
  ok("curl");
} catch {
  bad("缺少 curl.exe（Windows 10 1803 以上自带）");
  process.exit(1);
}

/* 3. Windows MediaPlayer 解码能力 */
try {
  execFileSync("powershell", ["-NoProfile", "-Command",
    "if(-not (Test-Path 'C:\\Windows\\System32\\wmp.dll')){exit 1}"], { stdio: "ignore" });
  ok("Windows 媒体组件");
} catch {
  bad("缺少 Windows 媒体组件（wmp.dll），无法播放");
  process.exit(1);
}

/* 4. 生成命令入口 */
if (!fs.existsSync(BIN)) fs.mkdirSync(BIN, { recursive: true });
const localNode = path.join(DIR, "node.exe");
const nodeCmd = fs.existsSync(localNode) ? localNode : "node";
const cmdPath = path.join(BIN, "ncm.cmd");
fs.writeFileSync(cmdPath, `@echo off\r\n"${nodeCmd}" "${path.join(DIR, "ncm.js")}" %*\r\n`, "utf8");
const shPath = path.join(BIN, "ncm");
fs.writeFileSync(shPath, `#!/usr/bin/env bash\nexec "$(cygpath -u "${nodeCmd}" 2>/dev/null || echo "${nodeCmd.replace(/\\/g, "/")}")" "${path.join(DIR, "ncm.js").replace(/\\/g, "/")}" "$@"\n`, "utf8");
try { fs.chmodSync(shPath, 0o755); } catch {}
ok(`命令入口 ${BIN}\\ncm` + (fs.existsSync(localNode) ? "（内置 node.exe）" : ""));

/* 5. PATH */
let inPath = false;
try {
  const up = execFileSync("powershell", ["-NoProfile", "-Command",
    "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: "utf8" }).trim();
  inPath = up.split(";").map(s => s.toLowerCase().replace(/\\+$/, "")).includes(BIN.toLowerCase().replace(/\\+$/, ""));
  if (!inPath) {
    execFileSync("powershell", ["-NoProfile", "-Command",
      `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p.EndsWith(';')){$p=$p+';'}; [Environment]::SetEnvironmentVariable('Path', $p + '${BIN}', 'User')`],
      { stdio: "ignore" });
  }
} catch {}
ok(inPath ? "PATH 已包含" : `PATH 已加入（新开终端生效）`);

/* 6. 登录态 */
const cookiePath = path.join(DIR, "cookie.txt");
const hasCookie = fs.existsSync(cookiePath) && fs.readFileSync(cookiePath, "utf8").trim().length > 20;

line("\n" + "=".repeat(40));
if (hasCookie) {
  line("已检测到登录态。直接开始：");
  line("  ncm list 20");
  line("  ncm play 1");
} else {
  line("还差一步：绑定你的网易云账号\n");
  line("  在有网易云客户端的机器上，运行：");
  line("      ncm login");
  line("  （会自动重启客户端以读取登录态，不影响你的登录）\n");
  line("  没有客户端的话，把浏览器里的 MUSIC_U 值贴进：");
  line("      " + cookiePath);
}
line("");
