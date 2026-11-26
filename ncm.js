#!/usr/bin/env node
// ncm — 网易云终端播放器（不依赖客户端界面）
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

// Node 18/20 的全局 WebSocket 需要 --experimental-websocket，自动补上
if (typeof WebSocket === "undefined" && !process.env.NCM_WS_BOOT) {
  const r = require("child_process").spawnSync(process.execPath,
    ["--experimental-websocket", __filename, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, NCM_WS_BOOT: "1" } });
  process.exit(r.status ?? 0);
}

const DIR = __dirname;
const PORT = 9334;
const BASE = `http://127.0.0.1:${PORT}`;

const w = s => [...String(s ?? "")].reduce((a, c) => a + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => { s = String(s ?? ""); const d = n - w(s); return d > 0 ? s + " ".repeat(d) : s; };
const fmt = ms => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function clientExe() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "(Get-ItemProperty 'HKLM:\\Software\\Classes\\orpheus\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'"],
      { encoding: "utf8" }).trim();
    const m = out.match(/^"([^"]+)"/) || out.match(/^([^\s]+?\.exe)/i);
    if (m && fs.existsSync(m[1])) return m[1];
  } catch {}
  for (const c of ["C:/Program Files/CloudMusic/cloudmusic.exe", "C:/Program Files (x86)/CloudMusic/cloudmusic.exe"]) if (fs.existsSync(c)) return c;
  return null;
}

async function req(p, ms = 240000) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(ms) });
  return r.json();
}
const alive = async () => { try { await fetch(BASE + "/status", { signal: AbortSignal.timeout(800) }); return true; } catch { return false; } };

async function ensureDaemon() {
  try {
    const s = await (await fetch(BASE + "/status", { signal: AbortSignal.timeout(1500) })).json();
    if (s.dir === DIR) return;
    try { await fetch(BASE + "/quit", { signal: AbortSignal.timeout(2000) }); } catch {}
    for (let i = 0; i < 20; i++) { await sleep(200); if (!(await alive())) break; }
  } catch {}
  if (await alive()) return;
  const child = spawn(process.execPath, [path.join(DIR, "daemon.js")], {
    detached: true, stdio: "ignore", windowsHide: true, cwd: DIR,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await alive()) return;
    await sleep(250);
  }
  throw new Error("daemon 启动失败（看 " + path.join(DIR, "daemon.log") + "）");
}

function bar(pos, dur, width = 28) {
  if (!dur) return "";
  const p = Math.min(1, Math.max(0, pos / dur));
  const i = Math.round(p * width);
  return "[" + "=".repeat(Math.max(0, i - 1)) + ">" + " ".repeat(width - i) + "]";
}

/* ---------- 命令实现 ---------- */
const ALIAS = {
  l: "list", ls: "list",
  s: "search", f: "search",
  p: "play", play: "play",
  n: "next", prev: "prev", b: "prev",
  pa: "pause", pause: "pause",
  r: "resume", resume: "resume",
  t: "toggle", toggle: "toggle",
  v: "vol", vol: "vol",
  q: "quit", quit: "quit", exit: "quit",
  now: "now", st: "now", status: "now",
  h: "help", help: "help", "?": "help",
  stop: "stop",
  m: "mode", mode: "mode",
  shuffle: "mode", single: "mode", order: "mode", random: "mode",
};
const MODE_MAP = { shuffle: "shuffle", random: "shuffle", single: "single", order: "order" };

const MODE_CN = { order: "顺序", single: "单曲循环", shuffle: "随机" };

async function stateLine() {
  const s = await req("/status", 5000);
  if (!s.cur) return "○ 未播放";
  return `${s.paused ? "⏸" : "▶"} ${s.cur.title} — ${s.cur.artist}  ${fmt(s.pos * 1000)}/${fmt((s.dur || 0) * 1000)}  ${s.cur.q || ""}  ${MODE_CN[s.playMode] || ""}`;
}

async function runOne(line) {
  const parts = line.trim().split(/\s+/);
  let cmd = parts[0];
  let rest = parts.slice(1);

  // 直接敲数字 = 播放该序号
  if (/^\d+$/.test(cmd)) { rest = [cmd, ...rest]; cmd = "play"; }
  cmd = ALIAS[cmd] || cmd;

  if (cmd === "help") {
    return [
      "命令（数字直接播歌）",
      "  <数字>          播放第 N 首      例: 42",
      "  list [N|all]    歌单              l 10",
      "  search <词>     搜歌              s Artist A",
      "  next/prev       切歌              n / b",
      "  pause/resume    暂停/继续         pa / r",
      "  toggle          切换              t",
      "  vol <0-100>     音量              v 60",
      "  now             当前状态          （回车也行）",
      "  mode [类型]     播放模式          m / m shuffle",
      "  stop            停止",
      "  (退出后 ncm ui 进入全屏界面)",
      "  quit            （单命令）关闭后台服务",
      "  q               退出交互模式（音乐继续放）",
    ].join("\n");
  }

  if (cmd === "quit") {
    if (await alive()) await req("/quit", 3000).catch(() => {});
    return "__QUIT__";
  }

  await ensureDaemon();

  if (cmd === "list") {
    const arg = rest[0];
    const d = await req("/list" + (arg === "refresh" ? "?refresh=1" : ""));
    if (!d.ok) throw new Error(d.err || "读取歌单失败");
    const limit = arg === "all" ? d.tracks.length : (parseInt(arg, 10) || 30);
    const out = [`${d.nick} · ${d.playlist.name} · ${d.playlist.count} 首`, ""];
    out.push(pad("#", 5) + pad("歌名", 46) + pad("歌手", 24) + pad("专辑", 20) + "时长");
    out.push("-".repeat(102));
    for (const t of d.tracks.slice(0, limit)) {
      out.push(pad(t.n, 5) + pad(t.title, 46) + pad(t.artist, 24) + pad(t.album, 20) + fmt(t.ms));
    }
    if (limit < d.tracks.length) out.push(`\n… 共 ${d.tracks.length} 首（list all）`);
    return out.join("\n");
  }

  if (cmd === "search") {
    if (!rest[0]) throw new Error("用法: search <关键词>");
    const kw = rest.join(" ").toLowerCase();
    const d = await req("/list");
    if (!d.ok) throw new Error(d.err || "读取歌单失败");
    const hit = d.tracks.filter(t => (t.title + " " + t.artist + " " + t.album).toLowerCase().includes(kw));
    if (hit.length) {
      const out = [`歌单内匹配 ${hit.length} 首（取前 20）`, ""];
      out.push(pad("#", 5) + pad("歌名", 46) + pad("歌手", 24) + "时长");
      for (const t of hit.slice(0, 20)) out.push(pad(t.n, 5) + pad(t.title, 46) + pad(t.artist, 24) + fmt(t.ms));
      return out.join("\n");
    }
    const g = await req("/search?q=" + encodeURIComponent(rest.join(" ")));
    if (!g.ok || !g.result.length) return "歌单内无匹配，全网也没搜到";
    const out = ["歌单内无匹配 · 全网结果（playid <ID> 直接播）", ""];
    out.push(pad("ID", 12) + pad("歌名", 40) + pad("歌手", 24) + "时长");
    for (const t of g.result) out.push(pad(t.id, 12) + pad(t.title, 40) + pad(t.artist, 24) + fmt(t.ms));
    return out.join("\n");
  }

  if (cmd === "play") {
    const n = parseInt(rest[0], 10);
    if (!n) throw new Error("用法: play <序号>");
    const r = await req("/play?n=" + n);
    if (!r.ok) throw new Error(r.err + (r.authFail ? "\n  → 运行 ncm login 刷新登录态" : ""));
    return `▶ #${r.track.n} ${r.track.title} — ${r.track.artist}  [${r.q || ""}]`;
  }

  if (cmd === "playid") {
    const id = parseInt(rest[0], 10);
    if (!id) throw new Error("用法: playid <歌曲ID>");
    const r = await req("/playid?id=" + id);
    if (!r.ok) throw new Error(r.err);
    return `▶ ${r.track.title} — ${r.track.artist}  [${r.q || ""}]`;
  }

  if (cmd === "next" || cmd === "prev") {
    const r = await req("/" + cmd);
    if (!r.ok) throw new Error(r.err);
    const skip = r.skippedCount ? `（跳过 ${r.skippedCount} 首无音源）` : "";
    return `▶ #${r.track.n} ${r.track.title} — ${r.track.artist}  [${r.q || ""}]${skip}`;
  }

  if (cmd === "pause" || cmd === "resume" || cmd === "toggle") {
    const r = await req("/" + cmd);
    return r.paused ? "⏸ 已暂停" : "▶ 播放中";
  }

  if (cmd === "vol") {
    const v = parseInt(rest[0], 10);
    if (isNaN(v)) { const s = await req("/status"); return `音量 ${Math.round(s.vol * 100)}`; }
    const r = await req("/vol?v=" + Math.min(100, Math.max(0, v)) / 100);
    return `音量 ${Math.round(r.vol * 100)}`;
  }

  if (cmd === "mode") {
    // shuffle / single / order 这些词本身带参数
    const want = MODE_MAP[parts[0]] || rest[0];
    if (!want) {
      const s = await req("/status", 5000);
      return `播放模式: ${MODE_CN[s.playMode] || s.playMode}（order 顺序 / single 单曲循环 / shuffle 随机）`;
    }
    if (!["order", "single", "shuffle"].includes(want)) throw new Error("模式须为 order / single / shuffle");
    const r = await req("/mode?m=" + want);
    if (!r.ok) throw new Error(r.err);
    return `播放模式: ${MODE_CN[r.playMode]}`;
  }

  if (cmd === "stop") {
    await req("/stop");
    return "已停止";
  }

  if (cmd === "now") {
    const s = await req("/status");
    const out = [];
    if (s.auth && s.auth.ok === false) out.push("[!] 登录态已失效（cookie 过期）→ 运行 ncm login 刷新", "");
    if (!s.cur) { out.push(`未播放 · list 看歌单${s.auth?.ok ? " · 账号 " + (s.auth.nick || "已登录") : ""}`); return out.join("\n"); }
    out.push(`${s.paused ? "⏸" : "▶"} ${s.cur.title} — ${s.cur.artist}`);
    out.push(`  #${s.cur.n}  ${bar(s.pos, s.dur)}  ${fmt(s.pos * 1000)} / ${fmt((s.dur || 0) * 1000)}  ${Math.round(s.vol * 100)}%  ${s.cur.q || ""}  ${MODE_CN[s.playMode] || ""}`);
    if (s.cur.album) out.push(`  《${s.cur.album}》`);
    return out.join("\n");
  }

  if (cmd === "login") {
    const port = process.env.NCM_CDP_PORT || 9333;
    const probe = async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) })).ok; } catch { return false; } };
    if (!(await probe())) {
      const exe = clientExe();
      if (!exe) throw new Error("未找到网易云客户端，请手动把 MUSIC_U 贴进 " + path.join(DIR, "cookie.txt"));
      console.log("● 正在切换客户端到调试模式（会重启它，登录态不变）…");
      try { spawn("powershell", ["-NoProfile", "-Command", "Stop-Process -Name cloudmusic -Force -ErrorAction SilentlyContinue"], { stdio: "ignore", windowsHide: true }).unref(); } catch {}
      await sleep(2500);
      spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      for (let i = 0; i < 40; i++) { await sleep(500); if (await probe()) break; }
      if (!(await probe())) throw new Error("客户端已启动但调试端口未就绪，请重试 ncm login");
    }
    let ck = null;
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
      const page = list.find(t => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 连接失败")); });
      let id = 0; const pend = new Map();
      ws.onmessage = e => { const mm = JSON.parse(e.data); if (mm.id && pend.has(mm.id)) { pend.get(mm.id)(mm); pend.delete(mm.id); } };
      const send = (mm, pp = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: pp })); });
      await sleep(1200);
      await send("Network.enable", {});
      for (let i = 0; i < 6 && !ck; i++) {
        const r = await send("Network.getCookies", { urls: ["https://music.163.com/"] });
        const cookies = r.result?.cookies || [];
        if (cookies.find(c => c.name === "MUSIC_U")) ck = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        else await sleep(1500);
      }
      ws.close();
    } catch (e) { console.log("  诊断: " + e.message); }
    if (!ck) throw new Error("抓不到登录态。让客户端带 --remote-debugging-port=9333 启动后重试，或手动把 MUSIC_U 贴进 " + path.join(DIR, "cookie.txt"));
    fs.writeFileSync(path.join(DIR, "cookie.txt"), ck, "utf8");
    const old = path.join(DIR, "tracks.json");
    if (fs.existsSync(old)) fs.unlinkSync(old);
    if (await alive()) await req("/list?refresh=1");
    return `✓ 登录态已保存（${ck.length} 字节）`;
  }

  throw new Error(`未知命令: ${cmd}（h 看帮助）`);
}

/* ---------- 交互模式 ---------- */
async function shell() {
  try { await ensureDaemon(); } catch (e) { console.error("✗ " + e.message); process.exit(1); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "ncm> ", historySize: 300, terminal: process.stdin.isTTY });
  rl.pause();                 // 先别读，等监听器挂好
  let chain = Promise.resolve();
  rl.on("line", line => {
    chain = chain.then(async () => {
      const l = line.trim();
      if (["q", "quit", "exit"].includes(l)) { rl.close(); return; }
      if (!l) { console.log(await stateLine() + "\n"); rl.prompt(); return; }
      try {
        const out = await runOne(l);
        if (out === "__QUIT__") { rl.close(); return; }
        console.log(out + "\n");
        if (/^\d+$/.test(l) || ["p", "play", "n", "next", "b", "prev", "pa", "pause", "r", "resume", "t", "toggle"].includes(l.split(/\s+/)[0])) {
          console.log(await stateLine() + "\n");
        }
      } catch (e) {
        console.error("✗ " + e.message + "\n");
      }
      rl.prompt();
    });
  });
  rl.on("SIGINT", () => { rl.close(); });
  (async () => {
    console.log("ncm 交互模式 · 敲数字直接播 · h 帮助 · q 退出\n");
    console.log((await stateLine()) + "\n");
    rl.prompt();
    rl.resume();
  })();
  rl.on("close", () => {
    // 非 TTY（管道）时所有行会一次性涌入，必须等队列跑完再退出
    chain.then(() => { console.log("\n再见"); process.exit(0); });
  });
}

/* ---------- 单命令模式 ---------- */
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "ui" || argv[0] === "tui") {
    const { spawnSync } = require("child_process");
    const r = spawnSync(process.execPath, [path.join(DIR, "tui.js"), ...argv.slice(1)], { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
  if (argv.length === 0) return shell();
  try {
    const out = await runOne(argv.join(" "));
    if (out !== "__QUIT__") console.log(out);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }
}
main();
