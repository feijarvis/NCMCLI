#!/usr/bin/env node
// ncm — 终端选歌/播放（不依赖网易云客户端界面）
const fs = require("fs");
const path = require("path");
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

async function req(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(240000) });
  return r.json();
}
function clientExe() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "(Get-ItemProperty 'HKLM:\\Software\\Classes\\orpheus\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'"],
      { encoding: "utf8" }).trim();
    const m = out.match(/^"([^"]+)"/);
    if (m && fs.existsSync(m[1])) return m[1];
    const m2 = out.match(/^([^\s]+?\.exe)/i);
    if (m2 && fs.existsSync(m2[1])) return m2[1];
  } catch {}
  for (const c of ["C:/Program Files/CloudMusic/cloudmusic.exe", "C:/Program Files/CloudMusic/cloudmusic.exe"]) if (fs.existsSync(c)) return c;
  return null;
}
const alive = async () => { try { await fetch(BASE + "/status", { signal: AbortSignal.timeout(800) }); return true; } catch { return false; } };

async function ensureDaemon() {
  try {
    const s = await (await fetch(BASE + "/status", { signal: AbortSignal.timeout(1500) })).json();
    if (s.dir === DIR) return;
    // 端口被另一份拷贝的 daemon 占着，让它退出
    try { await fetch(BASE + "/quit", { signal: AbortSignal.timeout(2000) }); } catch {}
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 200)); if (!(await alive())) break; }
  } catch {}
  const child = spawn(process.execPath, [path.join(DIR, "daemon.js")], {
    detached: true, stdio: "ignore", windowsHide: true, cwd: DIR,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await alive()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("daemon 启动失败（看 ~/ncm/daemon.log）");
}

function bar(pos, dur, width = 28) {
  if (!dur) return "";
  const p = Math.min(1, Math.max(0, pos / dur));
  const i = Math.round(p * width);
  return "[" + "=".repeat(Math.max(0, i - 1)) + ">" + " ".repeat(width - i) + "]";
}

async function main() {
  const [cmd = "now", ...rest] = process.argv.slice(2);
  const arg = rest[0];

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    return console.log(`ncm — 网易云终端播放器

  ncm list [N|all]      歌单
  ncm play <序号>       播放第 N 首
  ncm search <关键词>   在歌单里搜
  ncm now               当前状态
  ncm pause|resume|toggle
  ncm next|prev
  ncm vol <0-100>
  ncm stop              停止并退出播放器
  ncm quit              关闭 daemon`);
  }
  if (cmd === "quit") {
    if (await alive()) { await req("/quit"); console.log("daemon 已退出"); }
    else console.log("daemon 未运行");
    return;
  }
  if (cmd === "login") {
    const port = process.env.NCM_CDP_PORT || 9333;
    const probe = async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) })).ok; } catch { return false; } };
    if (!(await probe())) {
      const exe = clientExe();
      if (!exe) {
        console.error("未找到网易云客户端，请手动把 MUSIC_U 贴进 " + path.join(DIR, "cookie.txt"));
        process.exit(1);
      }
      console.log("● 正在切换客户端到调试模式（会重启它，登录态不变）…");
      try { spawn("powershell", ["-NoProfile", "-Command", "Stop-Process -Name cloudmusic -Force -ErrorAction SilentlyContinue"], { stdio: "ignore", windowsHide: true }).unref(); } catch {}
      await new Promise(r => setTimeout(r, 2500));
      spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 500)); if (await probe()) break; }
      if (!(await probe())) { console.error("客户端已启动但调试端口未就绪，请重试 ncm login"); process.exit(1); }
    }
    let ck = null;
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then(r => r.json());
      const page = list.find(t => t.type === "page");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
      let id = 0; const pending = new Map();
      ws.onmessage = e => { const mm = JSON.parse(e.data); if (mm.id && pending.has(mm.id)) { pending.get(mm.id)(mm); pending.delete(mm.id); } };
      const send = (mm, pp = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: pp })); });
      await new Promise(r => setTimeout(r, 1200));
      await send("Network.enable", {});
      for (let i = 0; i < 6 && !ck; i++) {
        const r = await send("Network.getCookies", { urls: ["https://music.163.com/"] });
        const cookies = r.result?.cookies || [];
        if (cookies.find(c => c.name === "MUSIC_U")) ck = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        else await new Promise(r2 => setTimeout(r2, 1500));
      }
      ws.close();
    } catch (e) { console.error("  诊断: " + e.message); }
    if (!ck) {
      console.error([
        "抓不到登录态。两种办法：",
        "  1) 让客户端带调试端口启动一次：",
        "     \"C:/Program Files/CloudMusic/cloudmusic.exe\" --remote-debugging-port=9333",
        "     再跑 ncm login",
        "  2) 手动把 MUSIC_U 写进 " + path.join(DIR, "cookie.txt"),
      ].join("\n"));
      process.exit(1);
    }
    fs.writeFileSync(path.join(DIR, "cookie.txt"), ck, "utf8");
    const old = path.join(DIR, "tracks.json");
    if (fs.existsSync(old)) fs.unlinkSync(old);
    console.log("✓ 登录态已保存（" + ck.length + " 字节）");
    if (await alive()) await req("/list?refresh=1"); else await ensureDaemon();
    console.log("✓ 歌单已刷新");
    return;
  }
  if (cmd === "stop") {
    if (await alive()) { await req("/stop"); console.log("已停止"); }
    else console.log("daemon 未运行");
    return;
  }

  await ensureDaemon();

  switch (cmd) {
    case "list":
    case "ls": {
      const d = await req("/list" + (arg === "refresh" ? "?refresh=1" : ""));
      if (!d.ok) return console.error("✗ " + (d.err || "读取歌单失败")) || process.exit(1);
      const limit = arg === "all" ? d.tracks.length : (parseInt(arg, 10) || 30);
      console.log(`${d.nick} · ${d.playlist.name} · ${d.playlist.count} 首\n`);
      console.log(pad("#", 5) + pad("歌名", 46) + pad("歌手", 24) + pad("专辑", 20) + "时长");
      console.log("-".repeat(102));
      for (const t of d.tracks.slice(0, limit)) {
        console.log(pad(t.n, 5) + pad(t.title, 46) + pad(t.artist, 24) + pad(t.album, 20) + fmt(t.ms));
      }
      if (limit < d.tracks.length) console.log(`\n… 共 ${d.tracks.length} 首（ncm list all）`);
      break;
    }
    case "search":
    case "s": {
      if (!arg) return console.error("用法: ncm search <关键词>");
      const d = await req("/list");
      if (!d.ok) return console.error("✗ " + (d.err || "读取歌单失败")) || process.exit(1);
      const kw = arg.toLowerCase();
      const hit = d.tracks.filter(t => (t.title + " " + t.artist + " " + t.album).toLowerCase().includes(kw));
      if (hit.length) {
        console.log(`歌单内匹配 ${hit.length} 首（取前 20）\n`);
        console.log(pad("#", 5) + pad("歌名", 46) + pad("歌手", 24) + "时长");
        for (const t of hit.slice(0, 20)) console.log(pad(t.n, 5) + pad(t.title, 46) + pad(t.artist, 24) + fmt(t.ms));
        break;
      }
      const g = await req("/search?q=" + encodeURIComponent(arg));
      if (!g.ok || !g.result.length) return console.log("歌单内无匹配，全网也没搜到");
      console.log(`歌单内无匹配 · 全网搜索结果（ncm playid <ID> 直接播）\n`);
      console.log(pad("ID", 12) + pad("歌名", 40) + pad("歌手", 24) + "时长");
      for (const t of g.result) console.log(pad(t.id, 12) + pad(t.title, 40) + pad(t.artist, 24) + fmt(t.ms));
      break;
    }
    case "play":
    case "p": {
      const n = parseInt(arg, 10);
      if (!n) return console.error("用法: ncm play <序号>");
      const r = await req("/play?n=" + n);
      if (!r.ok) {
        console.error("✗ " + r.err);
        if (r.track) console.error(`  #${r.track.n} ${r.track.title} — ${r.track.artist}`);
        if (r.authFail) console.error("  刷新方法二选一：客户端带 --remote-debugging-port=9333 启动后跑 ncm login；或把 MUSIC_U 贴进 " + path.join(DIR, "cookie.txt") + "");
        process.exit(1);
      }
      console.log(`▶ #${r.track.n} ${r.track.title} — ${r.track.artist}  [${r.q || Math.round((r.br || 0) / 1000) + "k"}]`);
      break;
    }
    case "playid":
    case "pi": {
      const id = parseInt(arg, 10);
      if (!id) return console.error("用法: ncm playid <歌曲ID>");
      const r = await req("/playid?id=" + id);
      if (!r.ok) { console.error("✗ " + r.err); process.exit(1); }
      console.log(`▶ ${r.track.title} — ${r.track.artist}  [${r.q || ""}]`);
      break;
    }
    case "next": { const r = await req("/next"); if (!r.ok) { console.error("✗ " + r.err); process.exit(1); } console.log(`▶ #${r.track.n} ${r.track.title} — ${r.track.artist}  [${r.q || ""}]`); break; }
    case "prev": { const r = await req("/prev"); if (!r.ok) { console.error("✗ " + r.err); process.exit(1); } console.log(`▶ #${r.track.n} ${r.track.title} — ${r.track.artist}`); break; }
    case "pause": case "resume": case "toggle": {
      const r = await req("/" + cmd);
      console.log(r.paused ? "⏸ 已暂停" : "▶ 播放中");
      break;
    }
    case "vol": {
      const v = parseInt(arg, 10);
      if (isNaN(v)) { const s = await req("/status"); return console.log(`音量 ${Math.round(s.vol * 100)}`); }
      const r = await req("/vol?v=" + (v / 100));
      console.log(`音量 ${Math.round(r.vol * 100)}`);
      break;
    }
    case "now":
    case "status": {
      const s = await req("/status");
      if (s.auth && s.auth.ok === false) console.log("[!] 登录态已失效（cookie 过期）→ 运行 ncm login 刷新\n");
      if (!s.cur) return console.log(`未播放 · ncm list 看歌单${s.auth?.ok ? " · 账号 " + (s.auth.nick || "已登录") : ""}`);
      const state = s.paused ? "⏸" : "▶";
      console.log(`${state} ${s.cur.title} — ${s.cur.artist}`);
      console.log(`  #${s.cur.n}  ${bar(s.pos, s.dur)}  ${fmt(s.pos * 1000)} / ${fmt((s.dur || 0) * 1000)}  ${Math.round(s.vol * 100)}%  ${s.cur.q || ""}`);
      if (s.cur.album) console.log(`  《${s.cur.album}》`);
      break;
    }
    default:
      console.log(`未知命令: ${cmd}（ncm help）`);
  }
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
