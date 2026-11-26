// ncm daemon — 常驻播放服务：weapi 取直链 + Windows MediaPlayer 出声
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const DIR = __dirname;
const PORT = 9334;
const COOKIE_FILE = path.join(DIR, "cookie.txt");
const CACHE_FILE = path.join(DIR, "tracks.json");
const CACHE_TTL = 1800e3;
const VOLUME = 0.85;

/* ---------- weapi ---------- */
const PRESET = "0CoJUm6Qyw8W8jud";
const IV = "0102030405060708";
const PUBKEY = "010001";
const MODULUS = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
const aes = (t, k) => {
  const c = crypto.createCipheriv("aes-128-cbc", Buffer.from(k), Buffer.from(IV));
  return Buffer.concat([c.update(Buffer.from(t)), c.final()]).toString("base64");
};
const rsa = (t, k, m) => {
  const r = Buffer.from(t.split("").reverse().join("")).toString("hex");
  return (BigInt("0x" + r) ** BigInt("0x" + k) % BigInt("0x" + m)).toString(16).padStart(256, "0");
};
const cookie = () => fs.readFileSync(COOKIE_FILE, "utf8").trim();
function post(p, payload) {
  const sec = crypto.randomBytes(8).toString("hex").slice(0, 16);
  const body = new URLSearchParams({
    params: aes(aes(JSON.stringify(payload), PRESET), sec),
    encSecKey: rsa(sec, PUBKEY, MODULUS),
  }).toString();
  const out = execFileSync("curl", ["-s", "-m", "25", "-X", "POST",
    "-H", `Cookie: ${cookie()}`, "-H", "Referer: https://music.163.com/",
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "--data", body, `https://music.163.com${p}`], { encoding: "utf8", maxBuffer: 48 * 1024 * 1024 });
  return JSON.parse(out);
}
function get(p) {
  const out = execFileSync("curl", ["-s", "-m", "25", "-H", `Cookie: ${cookie()}`,
    "-H", "Referer: https://music.163.com/", `https://music.163.com${p}`],
    { encoding: "utf8", maxBuffer: 96 * 1024 * 1024 });
  return JSON.parse(out);
}

/* ---------- 登录态 ---------- */
const auth = { ok: null, checkedAt: 0, nick: "" };
function checkAuth() {
  try {
    const a = get("/api/nuser/account/get");
    const ok = a.code === 200 && !!a.account;
    auth.ok = ok; auth.checkedAt = Date.now(); auth.nick = a.profile?.nickname || "";
    return ok;
  } catch (e) {
    auth.ok = false; auth.checkedAt = Date.now(); auth.err = e.message;
    return false;
  }
}

/* ---------- 歌单 ---------- */
let lib = null;
function loadLib(force) {
  if (!force && lib) return lib;
  if (!fs.existsSync(COOKIE_FILE)) throw new Error("未登录：请先运行 ncm login");
  if (!force && fs.existsSync(CACHE_FILE)) {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (Date.now() - c.at < CACHE_TTL && c.tracks?.length) { lib = c; return lib; }
  }
  const acc = get("/api/nuser/account/get");
  if (acc.code !== 200 || !acc.account) throw new Error("cookie 失效，请重新执行 ncm login");
  const lists = get(`/api/user/playlist?offset=0&limit=1000&uid=${acc.account.id}`).playlist || [];
  const liked = lists.find(p => p.specialType === 5) || lists[0];
  const det = get(`/api/v6/playlist/detail?id=${liked.id}&n=1000`);
  const tracks = (det.playlist.tracks || []).map((t, i) => ({
    n: i + 1, id: t.id, title: t.name,
    artist: (t.ar || []).map(a => a.name).join(" / "),
    album: (t.al || {}).name || "",
    ms: t.dt || 0,
  }));
  lib = { at: Date.now(), nick: acc.profile?.nickname || "", playlist: { id: liked.id, name: det.playlist.name, count: det.playlist.trackCount }, tracks };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(lib), "utf8");
  return lib;
}
const fmt = ms => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
// VIP 优先: hi-res -> 无损 -> 320k -> 192k -> 128k（接口会按账号权限自动降级返回）
function songUrl(id) {
  for (const level of ["hires", "lossless", "exhigh"]) {
    let r;
    try { r = post("/weapi/song/enhance/player/url/v1", { ids: JSON.stringify([id]), level, encodeType: "flac" }); } catch { continue; }
    const d = r.data && r.data[0];
    if (d && d.url) return { url: d.url, br: d.br || 0, type: d.type || "", level };
  }
  return null;
}
function quality(d) {
  const k = Math.round((d.br || 0) / 1000);
  if ((d.type || "").startsWith("flac")) return (d.br >= 1411200 ? "Hi-Res " : "无损 ") + k + "k";
  return k + "k";
}

/* ---------- 播放器子进程 ---------- */
const ps = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(DIR, "player.ps1")],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let outBuf = "";
let lastStatus = { pos: 0, dur: 0 };
ps.stdout.on("data", d => {
  outBuf += d.toString();
  const lines = outBuf.split(/\r?\n/);
  outBuf = lines.pop();
  for (const ln of lines) {
    const m = ln.match(/^STATUS\s+([\d.]+)\s+([\d.]+)/);
    if (m) lastStatus = { pos: parseFloat(m[1]), dur: parseFloat(m[2]) };
    else if (ln.startsWith("ERR")) log(ln);
  }
});
ps.stderr.on("data", d => log("[ps] " + d.toString().trim()));
ps.on("exit", c => { log("player exited " + c); process.exit(1); });
const cmd = c => ps.stdin.write(c + "\n");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) { try { fs.appendFileSync(path.join(DIR, "daemon.log"), new Date().toISOString() + " " + msg + "\n"); } catch {} }

/* ---------- 状态 ---------- */
const st = { playing: false, paused: false, cur: null, vol: VOLUME, playMode: "order" };
const backStack = [];
const MODES = ["order", "single", "shuffle"];
cmd("VOL " + VOLUME);
setTimeout(() => { try { loadLib(); } catch (e) { log("lib: " + e.message); } }, 100);
async function poll() { cmd("STATUS"); }
setInterval(poll, 700);

async function playSong(t, noBack) {
  let s;
  try { s = songUrl(t.id); } catch (e) { s = null; log("url: " + e.message); }
  if (!s) {
    const ok = checkAuth();
    if (!ok) return { ok: false, authFail: true, err: "登录态已失效（cookie 过期），运行 ncm login 刷新", track: t };
    return { ok: false, err: `《${t.title}》无可用音源（版权/VIP 限制）`, track: t };
  }
  auth.ok = true; auth.checkedAt = Date.now();
  if (!noBack && st.cur && st.cur.n !== t.n) {
    backStack.push(st.cur.n);
    if (backStack.length > 200) backStack.shift();
  }
  st.cur = { ...t, fmtDur: fmt(t.ms), br: s.br, type: s.type, q: quality(s) };
  st.playing = true; st.paused = false;
  lastStatus = { pos: 0, dur: 0 };
  cmd("PLAY " + s.url);
  return { ok: true, track: st.cur, br: s.br, q: st.cur.q };
}
async function playIndex(n, noBack) {
  const L = loadLib();
  const t = L.tracks.find(x => x.n === n);
  if (!t) return { ok: false, err: `序号 ${n} 超出 1-${L.tracks.length}` };
  return playSong(t, noBack);
}
function searchAll(q) {
  const r = get(`/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=12`);
  return (r.result?.songs || []).map(x => ({
    id: x.id,
    title: x.name,
    artist: (x.artists || []).map(a => a.name).join(" / "),
    album: (x.album || {}).name || "",
    ms: x.duration || 0,
    fee: x.fee ?? 0,
  }));
}
function songDetail(id) {
  const r = get(`/api/song/detail?ids=${encodeURIComponent(JSON.stringify([id]))}`).songs || [];
  const x = r[0];
  if (!x) return null;
  return { id: x.id, title: x.name, artist: (x.ar || x.artists || []).map(a => a.name).join(" / "), album: (x.al || x.album || {}).name || "", ms: x.dt || x.duration || 0 };
}
function pickNext(auto, exclude = new Set()) {
  const L = loadLib();
  const cur = st.cur;
  const total = L.tracks.length;
  if (!cur) return 1;
  // 单曲循环只影响"播完自动续播"；手动切歌、跳过无音源时都按顺序走
  if (auto && st.playMode === "single" && exclude.size === 0) return cur.n;
  if (st.playMode === "shuffle") {
    for (let i = 0; i < 60; i++) {
      const n = 1 + Math.floor(Math.random() * total);
      if (n !== cur.n && !exclude.has(n)) return n;
    }
    return cur.n;
  }
  let n = cur.n;
  for (let i = 0; i < total; i++) {
    n = n + 1 > total ? 1 : n + 1;
    if (!exclude.has(n)) return n;
  }
  return cur.n;
}

async function next(auto) {
  const skip = new Set();
  for (let i = 0; i < 6; i++) {
    const n = pickNext(auto && i === 0, skip);
    const r = await playIndex(n);
    if (r.ok) return skip.size ? { ...r, skippedCount: skip.size } : r;
    if (r.authFail) return r;
    skip.add(n);
  }
  return { ok: false, err: `连续 ${skip.size} 首无可用音源（版权限制）` };
}

async function prevTrack() {
  const L = loadLib();
  const cur = st.cur;
  if (backStack.length) return playIndex(backStack.pop(), true);
  if (!cur) return playIndex(1);
  return playIndex(cur.n > 1 ? cur.n - 1 : L.tracks.length);
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const q = Object.fromEntries(u.searchParams);
  const send = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };
  try {
    switch (u.pathname) {
      case "/status":
        return send({ ok: true, dir: DIR, playing: st.playing, paused: st.paused, pos: lastStatus.pos, dur: lastStatus.dur || (st.cur?.ms || 0) / 1000, cur: st.cur, vol: st.vol, auth, playMode: st.playMode });
      case "/list": {
        const L = loadLib(q.refresh === "1");
        return send({ ok: true, nick: L.nick, playlist: L.playlist, tracks: L.tracks });
      }
      case "/play": {
        const n = parseInt(q.n, 10);
        if (!n) return send({ ok: false, err: "需要 n" }, 400);
        const r = await playIndex(n);
        return send(r, r.ok ? 200 : 200);
      }
      case "/playid": {
        const id = parseInt(q.id, 10);
        if (!id) return send({ ok: false, err: "需要 id" }, 400);
        const d = songDetail(id);
        if (!d) return send({ ok: false, err: "查不到该歌曲" });
        return send(await playSong(d));
      }
      case "/search": {
        if (!q.q) return send({ ok: false, err: "需要 q" }, 400);
        return send({ ok: true, result: searchAll(q.q) });
      }
      case "/next": return send(await next(false));
      case "/prev": return send(await prevTrack());
      case "/pause": cmd("PAUSE"); st.paused = true; return send({ ok: true, paused: true });
      case "/resume": cmd("RESUME"); st.paused = false; st.playing = true; return send({ ok: true, paused: false });
      case "/toggle": {
        if (st.paused) { cmd("RESUME"); st.paused = false; } else { cmd("PAUSE"); st.paused = true; }
        return send({ ok: true, paused: st.paused });
      }
      case "/mode": {
        if (q.m) {
          if (!MODES.includes(q.m)) return send({ ok: false, err: "模式须为 order | single | shuffle" }, 400);
          st.playMode = q.m;
        }
        return send({ ok: true, playMode: st.playMode });
      }
      case "/stop": cmd("STOP"); st.playing = false; st.paused = false; st.cur = null; return send({ ok: true });
      case "/vol": {
        const v = Math.max(0, Math.min(1, parseFloat(q.v)));
        st.vol = v; cmd("VOL " + v); return send({ ok: true, vol: v });
      }
      case "/quit": send({ ok: true }); setTimeout(() => { try { cmd("QUIT"); } catch {} process.exit(0); }, 100); return;
      default: return send({ ok: false, err: "unknown" }, 404);
    }
  } catch (e) {
    log("http: " + e.message);
    return send({ ok: false, err: e.message }, 500);
  }
});

/* 自动连播：进度抵达结尾 */
let lastPos = 0, stall = 0;
setInterval(() => {
  const { pos, dur } = lastStatus;
  if (!st.playing || st.paused) { lastPos = pos; return; }
  if (dur > 1 && pos >= dur - 1.2) { next(true); lastPos = pos; return; }
  if (dur > 1 && pos === lastPos && pos > 0) { if (++stall > 12) { log("stalled, skip"); stall = 0; next(true); } }
  else stall = 0;
  lastPos = pos;
}, 1000);

setTimeout(checkAuth, 1200);
setInterval(() => { if (!st.playing) checkAuth(); }, 3600e3);
server.listen(PORT, "127.0.0.1", () => log(`daemon ready :${PORT}`));
process.on("SIGINT", () => process.exit(0));
process.on("exit", () => { try { cmd("QUIT"); } catch {} });
