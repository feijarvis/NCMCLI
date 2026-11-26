#!/usr/bin/env node
// ncm TUI — 全屏播放器界面（纯 ANSI，无依赖）
const { spawnSync } = require("child_process");

if (typeof WebSocket === "undefined" && !process.env.NCM_WS_BOOT) {
  const r = spawnSync(process.execPath, ["--experimental-websocket", __filename, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, NCM_WS_BOOT: "1" } });
  process.exit(r.status ?? 0);
}

const BASE = "http://127.0.0.1:9334";
const argv = process.argv.slice(2);
const DUMP = argv.includes("--dump");
const DEMO = argv.includes("--demo");

/* ---------- 文本宽度 ---------- */
const isWide = c => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(c);
const w = s => [...String(s ?? "")].reduce((a, c) => a + (isWide(c) ? 2 : 1), 0);
function clip(s, maxw) {
  s = String(s ?? "");
  if (w(s) <= maxw) return s;
  let out = "", n = 0;
  for (const c of s) {
    const cw = isWide(c) ? 2 : 1;
    if (n + cw >= maxw) { out += "…"; break; }
    out += c; n += cw;
  }
  return out + " ".repeat(Math.max(0, maxw - w(out)));
}
const padR = (s, n) => { s = String(s ?? ""); const d = n - w(s); return d > 0 ? s + " ".repeat(d) : clip(s, n); };
const fmt = ms => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/* ---------- 状态 ---------- */
const st = {
  nick: "", plName: "", tracks: [], view: [], sel: 0, top: 0,
  status: { cur: null, pos: 0, dur: 0, paused: false, vol: 0.85 },
  mode: "list", search: "", msg: "", msgAt: 0,
};

async function api(p, timeout = 30000) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(timeout) });
  return r.json();
}

async function loadList() {
  const d = await api("/list", 60000);
  if (!d.ok) throw new Error(d.err || "读取歌单失败");
  st.nick = d.nick; st.plName = d.playlist.name; st.tracks = d.tracks;
  applyFilter();
}

function applyFilter() {
  const q = st.search.trim().toLowerCase();
  st.view = q
    ? st.tracks.filter(t => (t.title + " " + t.artist + " " + t.album).toLowerCase().includes(q))
    : st.tracks;
  if (st.sel >= st.view.length) st.sel = Math.max(0, st.view.length - 1);
}

async function refreshStatus() {
  try {
    const s = await api("/status", 5000);
    st.status = s;
  } catch {}
}

function flash(m) { st.msg = m; st.msgAt = Date.now(); }

/* ---------- 渲染 ---------- */
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const vw = s => w(stripAnsi(s));
const vpad = (s, n) => { s = String(s ?? ""); const d = n - vw(s); return d > 0 ? s + " ".repeat(d) : clip(stripAnsi(s), n); };

function renderLines() {
  const W = process.stdout.columns || 100;
  const H = process.stdout.rows || 30;
  const side = W >= 92;
  const sideW = side ? Math.min(38, Math.max(28, Math.floor(W * 0.33))) : 0;
  const listW = side ? W - sideW - 1 : W;
  const bodyRows = Math.max(4, H - 3);

  if (st.sel < st.top) st.top = st.sel;
  if (st.sel >= st.top + bodyRows) st.top = st.sel - bodyRows + 1;
  if (st.top < 0) st.top = 0;

  const cur = st.status.cur;
  const out = [];

  /* 标题 */
  const badge = cur ? (st.status.paused ? "\u23f8" : "\u25b6") : "\u25cb";
  const nowTxt = cur ? `${cur.title} \u2014 ${cur.artist}` : "\u672a\u64ad\u653e";
  out.push(`\x1b[1m NCM\x1b[0m  ${st.nick} \u00b7 ${st.plName} \u00b7 ${st.tracks.length} \u9996   \x1b[32m${badge}\x1b[0m ${clip(nowTxt, Math.max(10, W - 50))}`);

  /* 左侧列表 */
  const left = [];
  const numW = 5, durW = 6;
  const artW = Math.min(22, Math.max(8, Math.floor(listW * 0.24)));
  const titleW = Math.max(8, listW - numW - durW - artW);
  left.push(`\x1b[90m${padR("#", numW)}${padR("\u6b4c\u540d", titleW)}${padR("\u6b4c\u624b", artW)}${padR("\u65f6\u957f", durW)}\x1b[0m`);
  for (let i = 0; i < bodyRows; i++) {
    const t = st.view[st.top + i];
    if (!t) { left.push(""); continue; }
    const selected = st.top + i === st.sel;
    const playing = cur && cur.n === t.n;
    const mark = playing ? (st.status.paused ? "\u23f8" : "\u25b8") : " ";
    const row = mark + padR(t.n, numW - 1) + padR(t.title, titleW) + padR(t.artist, artW) + padR(fmt(t.ms), durW);
    left.push(selected ? `\x1b[7m${padR(stripAnsi(row), listW)}\x1b[0m` : clip(row, listW));
  }

  /* 右侧面板 */
  const right = [];
  if (side) {
    const inner = sideW - 2;
    const L = s => " " + s;
    const blank = Math.max(0, Math.floor((bodyRows - 10) / 2));
    for (let i = 0; i < blank; i++) right.push("");
    if (cur) {
      right.push(L("\x1b[1m\u6b63\u5728\u64ad\u653e\x1b[0m"));
      right.push("");
      right.push(L(`\x1b[1m${clip(cur.title, inner)}\x1b[0m`));
      right.push(L(`\x1b[90m${clip(cur.artist, inner)}\x1b[0m`));
      right.push(L(`\x1b[90m${clip(cur.album ? "\u300a" + cur.album + "\u300b" : "", inner)}\x1b[0m`));
      right.push("");
      const bw = Math.max(8, inner - 1);
      const p = st.status.dur ? Math.min(1, st.status.pos / st.status.dur) : 0;
      const fill = Math.round(p * bw);
      right.push(L(`\x1b[36m${"\u2501".repeat(fill)}\x1b[90m${"\u2500".repeat(bw - fill)}\x1b[0m`));
      right.push(L(`\x1b[90m${fmt(st.status.pos * 1000)} / ${fmt((st.status.dur || 0) * 1000)}\x1b[0m`));
      right.push("");
      right.push(L(`\x1b[33m${cur.q || ""}\x1b[0m \x1b[90m\u97f3\u91cf ${Math.round((st.status.vol || 0) * 100)}%\x1b[0m`));
    } else {
      right.push(L("\x1b[90m\u672a\u64ad\u653e\x1b[0m"));
    }
    while (right.length < bodyRows) right.push("");
  }

  /* 合成 */
  for (let i = 0; i < bodyRows; i++) {
    const l = vpad(left[i] || "", listW);
    out.push(side ? l + "\x1b[90m\u2502\x1b[0m" + vpad(right[i] || "", sideW) : l);
  }

  /* 底部 */
  const help = st.mode === "search"
    ? `\x1b[36m\u641c\u7d22: ${st.search}\x1b[0m\x1b[90m  Enter \u64ad\u653e \u00b7 Esc \u53d6\u6d88\x1b[0m`
    : `\x1b[90m\u2191\u2193 \u9009\u62e9 \u00b7 Enter \u64ad\u653e \u00b7 Space \u6682\u505c \u00b7 n/b \u5207\u6b4c \u00b7 / \u641c\u7d22 \u00b7 q \u9000\u51fa\x1b[0m`;
  out.push(vpad(st.msg && Date.now() - st.msgAt < 2500 ? `\x1b[32m${st.msg}\x1b[0m` : help, W));

  return out;
}

let lastFrame = "";
function draw() {
  const lines = renderLines();
  const frame = "\x1b[H" + lines.map(l => "\x1b[2K" + l).join("\r\n");
  if (frame === lastFrame) return;
  lastFrame = frame;
  process.stdout.write(frame);
}

/* ---------- 按键 ---------- */
let timer = null;
async function handleKey(s) {
  if (st.mode === "search") {
    if (s === "\r") { st.mode = "list"; st.search = ""; applyFilter(); draw(); return; }
    if (s === "\x1b") { st.mode = "list"; st.search = ""; applyFilter(); draw(); return; }
    if (s === "\x7f") { st.search = st.search.slice(0, -1); applyFilter(); st.sel = 0; st.top = 0; draw(); return; }
    if (s.length === 1 && s >= " ") { st.search += s; applyFilter(); st.sel = 0; st.top = 0; draw(); return; }
    return;
  }
  switch (s) {
    case "\x1b[A": case "k": st.sel = Math.max(0, st.sel - 1); draw(); break;
    case "\x1b[B": case "j": st.sel = Math.min(st.view.length - 1, st.sel + 1); draw(); break;
    case "\x1b[5~": st.sel = Math.max(0, st.sel - 10); draw(); break;
    case "\x1b[6~": st.sel = Math.min(st.view.length - 1, st.sel + 10); draw(); break;
    case "g": st.sel = 0; st.top = 0; draw(); break;
    case "G": st.sel = st.view.length - 1; draw(); break;
    case "\r": {
      const t = st.view[st.sel];
      if (!t) break;
      flash(`播放 #${t.n} …`);
      draw();
      try {
        const r = await api("/play?n=" + t.n, 120000);
        if (r.ok) flash(`▶ ${r.track.title} — ${r.track.artist}`);
        else flash(`✗ ${r.err}`);
      } catch (e) { flash("✗ " + e.message); }
      await refreshStatus();
      draw();
      break;
    }
    case " ": {
      try {
        const r = await api("/toggle", 10000);
        st.status.paused = r.paused;
        flash(r.paused ? "⏸ 已暂停" : "▶ 继续");
      } catch (e) { flash("✗ " + e.message); }
      draw();
      break;
    }
    case "n": case "b": {
      try {
        const r = await api("/" + (s === "n" ? "next" : "prev"), 120000);
        if (r.ok) flash(`▶ ${r.track.title} — ${r.track.artist}`);
        else flash("✗ " + r.err);
      } catch (e) { flash("✗ " + e.message); }
      await refreshStatus();
      draw();
      break;
    }
    case "/": st.mode = "search"; st.search = ""; draw(); break;
    case "q": case "\x03": cleanup(); process.exit(0); break;
    case "\x1b": break;
    default: break;
  }
}

/* ---------- 生命周期 ---------- */
let ticker = null;
function cleanup() {
  clearInterval(ticker);
  if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

async function main() {
  await refreshStatus();
  await loadList();

  if (DUMP) {
    const cArg = argv.find(a => a.startsWith("--cols="));
    const rArg = argv.find(a => a.startsWith("--rows="));
    if (cArg) Object.defineProperty(process.stdout, "columns", { value: +cArg.split("=")[1], configurable: true });
    if (rArg) Object.defineProperty(process.stdout, "rows", { value: +rArg.split("=")[1], configurable: true });
    // 纯文本预览（去掉 ANSI），用于验证布局
    const strip = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    process.stdout.write(renderLines().map(strip).join("\n") + "\n");
    process.exit(0);
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let buf = "";
  process.stdin.on("data", async s => {
    buf += s;
    // 拆出完整按键序列
    while (buf.length) {
      let m = buf.match(/^\x1b\[[0-9;~]*[A-Za-z]/);
      if (m) { buf = buf.slice(m[0].length); await handleKey(m[0]); continue; }
      if (buf[0] === "\x1b") {
        if (buf.length === 1) { buf = ""; await handleKey("\x1b"); continue; }
        if (buf[1] !== "[") { buf = buf.slice(2); await handleKey("\x1b"); continue; }
        break;
      }
      const c = buf[0];
      buf = buf.slice(1);
      await handleKey(c);
    }
    draw();
  });

  process.stdout.on("resize", () => { lastFrame = ""; draw(); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  ticker = setInterval(async () => {
    await refreshStatus();
    draw();
  }, 800);

  draw();

  if (DEMO) {
    setTimeout(() => handleKey("\x1b[B"), 700);
    setTimeout(() => handleKey("\x1b[B"), 1100);
    setTimeout(() => handleKey("\r"), 1600);
    setTimeout(() => handleKey(" "), 4200);
    setTimeout(() => { cleanup(); process.exit(0); }, 6200);
  }
}

main().catch(e => { cleanup(); console.error("TUI 错误: " + e.message); process.exit(1); });
