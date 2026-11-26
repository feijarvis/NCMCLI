# 设计说明

记录这个工具为什么长成现在这样：走过的弯路、被否掉的方案、每个技术选型背后的约束。后面接手的人不该再走一遍。

---

## 1. 目标与约束

原始需求只有一句话：**不想打开网易云界面，在终端里选歌播放。**

衍生的硬约束：

1. 播的是**自己账号**里的音乐，不是第三方源
2. 音质要尽量高（账号是 VIP，不能白白浪费权限）
3. 不能是"另开一个播放器播放下载到本地的文件"——那样还得先下载
4. 目标机器可能没有开发环境（最终用户不能要求装 Node）

第 4 条是后来才明确的，它反过来决定了分发形态（见 §4.5）。

---

## 2. 三条路线的探索

在动手前先摸清客户端到底暴露了什么。依次验证了三条路，前两条都撞墙了。

### 路线 A：SMTC（系统媒体会话）

Windows 的 `GlobalSystemMediaTransportControlsSessionManager` 能读到当前播放的媒体信息，并且可以发 `TryPlayAsync` / `TrySkipNextAsync`。

**探明的事实**：

- 能读到 `cloudmusic.exe | 歌曲名 | 歌手 | Playing`
- 发控制指令**真实生效**（媒体信息随切歌更新）
- 但 `GetTimelineProperties()` 恒返回 `00:00:00` —— 网易云没有实现 timeline，拿不到进度

**不能做选歌**，只能做上一个/下一个/播放/暂停。而且 `cloudmusic.exe` 每次重启后不一定重新注册会话（实测杀掉重启后 `GetSessions()` 返回 0）。

结论：可以当兜底的控制手段，不能作为主体。

### 路线 B：客户端 UI 接管（UIA → CEF CDP）

客户端是新版（3.1.41，CEF 72，不是 Electron）。

- **UIA**：窗口能定位到（`OrpheusBrowserHost`），但 `TreeScope.Descendants` 返回 **0 个节点** —— 全套自绘 UI，UIA 完全不可用。
- **`orpheus://` 协议**：注册表指向 `cloudmusic.exe --webcmd="%1"`，是官方指令入口。发 `--webcmd="orpheus://song/108493"` 进程 exit 0，但**没有切歌**。指令集不明确，试错成本高。
- **CEF CDP**：客户端常驻 `127.0.0.1:20017`，但那是内置静态资源 nginx（非法 Host 返回 403），不是调试口。

只有重启客户端加 `--remote-debugging-port=9333` 才拿到 CDP。**拿到了，并且成功了**：

- 读到了完整歌单 DOM（`.tr` / `.td.td-num` / `.td.td-title`）
- 真实双击行 → 客户端播放 → CoreAudio 峰值 0.27，确认出声

但这条路有两个致命问题：

1. **必须让客户端进程跑着**，且停留在对应歌单路由
2. **虚拟列表用程序化 `scrollTop` 驱动不了**，必须发 CDP `Input.dispatchMouseEvent(type:"mouseWheel")` 真实滚轮事件；滚动 128 首要 10 次 wheel，还不时撞上渲染空窗（读到 `rows=0`），抓取成功率只有 420/685

结论：能做，但脆弱、慢、依赖 UI 状态。**放弃作为主路径**，代码移除。

### 路线 C：Web API 直取（最终方案）

绕开客户端，直接用账号 cookie 调接口：

- 免登录的 `/api/search/get` 可用（验证过）
- 带 `MUSIC_U` 后 `/api/nuser/account/get`、`/api/user/playlist`、`/api/v6/playlist/detail` 全部可用，**一次返回全部 128 首**
- 取直链的旧接口 `/api/song/enhance/player/url` 返回 `null`，必须走 weapi 加密的 `/weapi/song/enhance/player/url/v1`

结论：这条路一次性解决了「读歌单」和「取音源」，**且不需要客户端在跑**。

---

## 3. 架构

选定的分层：

```
┌──────────┐   HTTP/JSON    ┌────────────────┐   weapi    ┌──────────────┐
│  ncm.js  │ ─────────────▶ │    daemon.js   │ ─────────▶ │ music.163.com│
│  (CLI)   │ ◀───────────── │ 127.0.0.1:9334 │ ◀───────── │              │
└──────────┘                └───────┬────────┘            └──────────────┘
                                    │ stdin/stdout
                                    ▼
                            ┌────────────────┐   WPF MediaPlayer
                            │  player.ps1    │ ──────────────▶ 声卡
                            │ (PowerShell)   │
                            └────────────────┘
```

### 3.1 为什么是 daemon + HTTP，而不是每次命令自己播放

播放在终端里是**长时任务**（一首歌几分钟）。如果每条命令一个进程，`ncm play` 结束进程就退出，音乐也就停了。

daemon 常驻解决三件事：

- 持有播放器子进程的生命周期
- 维护队列与"播完自动下一首"的轮询
- 缓存 128 首的歌单（避免每次命令都打接口）

HTTP 而不是命名管道/socket：Windows 上最省事，调试时 `curl http://127.0.0.1:9334/status` 就能看状态。

### 3.2 为什么播放器是 PowerShell + WPF，而不是 ffplay/mpv/vlc

实测这台机器 `ffplay` / `mpv` / `vlc` / `ffmpeg` **一个都没有**。

而 `System.Windows.Media.MediaPlayer`：

- 系统自带（PresentationCore）
- 支持 HTTP 流式 MP3 与 FLAC（走 Windows Media Foundation）
- 能报 `Position` / `NaturalDuration`
- 不弹窗口

用 PowerShell 承载它的关键发现：**主线程阻塞在 `[Console]::In.ReadLine()` 时，播放不会中断**（实测 0→4.08→5.7 秒连续推进，PAUSE 后冻结在 4.5）。所以不需要 Dispatcher 泵，一个 `while($true){ ReadLine }` 就是完整的控制循环。

代价：拿不到 `MediaEnded` 事件（事件需要消息泵），所以改用**轮询 `Position >= Duration - 1.2s`** 判定播完。

### 3.3 为什么 weapi 自己实现

需要的加密：

1. `AES-128-CBC(json, "0CoJUm6Qyw8W8jud", iv)` → base64
2. 再 `AES-128-CBC(上面, random16, iv)` → base64
3. `RSA(random16 反转, e=010001, n=...)` 转 16 进制补零 256 位

Node 的 `crypto` 全包了，RSA 部分用 `BigInt` 做模幂（不需要 `jsencrypt`）。整个实现约 20 行，零依赖——考虑到目标机器可能没有 npm，这一点很重要。

### 3.4 音质策略

`/weapi/song/enhance/player/url/v1` 的 `level` 参数按账号权限返回上限。实测同一账号：

| 曲目 | standard | exhigh | lossless | hires |
|---|---|---|---|---|
| 歌曲 A | 128k | 320k | 1007k | 1007k |
| 歌曲 B（VIP） | 128k | 320k | 886k | **1656k** |
| 歌曲 C（源仅 128k） | 128k | 128k | 128k | 128k |

所以按 `hires → lossless → exhigh` 逐个试，取第一个有 url 的。请求失败/为空才降级，正常情况下第一次命中，延迟约 200ms。

第三种情况（源本身只有 128k）也要如实显示 128k——**不假装拿到了无损**。

### 3.5 分发形态：把 node.exe 塞进包里

最终用户机器可能没有 Node。三个选项：

- 重写为纯 PowerShell → weapi 的 RSA 大数运算在 PS 里极其痛苦，否决
- 用 .NET `csc.exe` 编译 → 工作量翻倍，收益低
- **打包便携 node.exe** → Windows 版 node.exe 是单文件绿色可执行（68MB → zip 后 27MB），直接 `spawn` 即可

选第三个。`install.js` 生成命令入口时优先指向包内 `node.exe`，找不到才退回 PATH 里的 `node`。

---

## 4. 踩过的坑

按发现顺序，每条都留下过实际故障。

### 4.1 SMTC 的 timeline 恒为 0

`GetTimelineProperties()` 对 cloudmusic 返回 `00:00:00`。一开始误以为没在播放，实际在播。**判据换成页面播放栏图标的 `cmd-icon-pause`**。

### 4.2 客户端重启后 SMTC 会话消失

杀进程重启客户端，`GetSessions()` 返回 0，且不会自行恢复。这是它注册逻辑的问题，不是我们的。所以整条 SMTC 路线被降级为"不依赖"。

### 4.3 虚拟列表只吃真实滚轮

`scrollTop = N` 对网易云的列表**完全无效**：`scrollTop` 变成 2800 了，DOM 还停在 675-685 行。手动 `dispatchEvent(new Event("scroll"))` 更糟——列表直接变成 0 行。

唯一有效的是 CDP `Input.dispatchMouseEvent` + `type: "mouseWheel"`。而且 `deltaY` 与 `scrollTop` 近似 1:1。

### 4.4 滚动抓取的渲染空窗

即使滚轮可用，虚拟列表在重渲染期间会短暂清空 DOM（`rows=0`）。按固定 `sleep` 抓取，128 首只能拿到 420~550。

这也是最终放弃 DOM 抓取、改走 API 的直接原因——**一次请求拿全量，1.6 秒**。

### 4.5 `WebSocket is not defined`

`ncm login` 用 CDP 抓 cookie，需要 `WebSocket`。Node 20 的全局 `WebSocket` 要 `--experimental-websocket`，否则 `ReferenceError`，而它被 `try/catch` 静默吞掉，最终表现为"抓不到登录态"。

修复：CLI 顶部自举，检测到没有 `WebSocket` 就带 flag 重新执行自己（`NCM_WS_BOOT` 环境变量防递归）。

### 4.6 多份拷贝抢 9334 端口

测试时把包解压到另一个目录跑，结果 CLI 连上了**旧目录的 daemon**，报"未登录"（因为旧目录的 cookie.txt 被我删了）。

修复：daemon 在 `/status` 里报自己的 `dir`，CLI 发现不一致就 `/quit` 让对方退出再接管。

### 4.7 无 cookie 时的错误信息是 `Cannot read properties of undefined (reading 'name')`

CLI 直接访问了 `d.playlist.name`，而 daemon 返回的是 `{ok:false, err}`。

修复：所有接口响应先判 `ok`，daemon 侧也先检查 `cookie.txt` 是否存在，报「未登录：请先运行 ncm login」。

### 4.8 音质显示用的是请求值而不是实际值

早期 `play` 显示 `[320k]` 是**请求**的码率。改成显示服务端返回的 `br` / `type` 换算后的值，这样源只有 128k 时不会假装是无损。

---

## 4.9 交互模式：readline 的两个坑

用户反馈"每次都要重新敲 ncm xxx，操作不连贯"，于是加了无参数的交互 shell。踩到两个坑：

**坑一：监听器注册晚于首个 await**

```js
const rl = readline.createInterface({...});   // 立刻开始消费 stdin
console.log(await stateLine());               // await 期间数据已流过
rl.on("line", ...);                           // 注册太晚，全部丢失
```

管道输入时表现为"敲了没反应"。修复：`rl.pause()` 建好后先挂监听器，打印完 banner 再 `rl.resume()`。

**坑二：非 TTY 下 close 抢跑**

`printf "cmd1\ncmd2\n" | ncm` 时，所有行瞬间涌入并紧接着触发 `close`。若 `close` 直接 `process.exit(0)`，异步命令队列还没跑完就被杀掉。

修复：`close` 时 `await` 队列。

**语义细节**：交互模式里 `q` 只退出 shell，不停止音乐（daemon 常驻）；`ncm quit`（单命令）才关后台。这是用户直觉——关掉界面不该中断播放。

## 4.10 TUI：为什么不用 blessed/ink

全屏界面用纯 ANSI 实现（`tui.js`，无任何依赖），原因和 weapi 自实现一致——目标机器可能没有 npm。

实现要点：

- **交替屏幕缓冲**：`\x1b[?1049h` 进入，`\x1b[?1049l` 退出，不污染用户的滚动历史
- **整帧重绘**：每帧拼一个完整字符串，`\x1b[H` 归位 + 每行 `\x1b[2K` 清行。685 行列表只渲染可见部分，2Hz 刷新毫无压力
- **脏检查**：帧内容不变就不写终端，避免光标闪烁
- **raw mode** 读键盘：方向键是 `\x1b[A/B`、`PgUp/PgDn` 是 `\x1b[5~/6~`，需要自己拆序列（`\x1b` 单独一个字节时是 Esc）
- **宽度计算**：CJK 占 2 列，截断要按显示宽度算，否则中英混排会错位
- **ANSI 感知的补白**：带颜色码的行不能用 `length` 算宽度，先 strip 再量

布局是响应式的：≥92 列双栏（列表 + 播放面板），否则单栏。右侧进度条用 `━` / `─` 字符自绘，不依赖终端图形能力。

`--dump` 参数输出一帧去 ANSI 的纯文本，用于在没有交互终端的环境（CI、管道、截图）里验证布局——这个模式在开发时反复用到。

## 5. 已知边界

| 边界 | 说明 |
|---|---|
| 平台 | 仅 Windows：WPF 解码、注册表定位客户端、CoreAudio 取证 |
| 版权 | 无版权/下架曲目返回空直链，明确报错，不静默跳过 |
| 直链时效 | 由服务端在 URL 中带时间戳，暂停很久再恢复可能失效 |
| 登录态 | 需 `MUSIC_U`；失效时 daemon 会通过 `account: null` 识别并在播放/`now` 中明示 |
| 队列 | 单一歌单顺序播放，暂无随机/单曲循环 |

## 6. 可验证性

工具是否"真的在出声"不靠感觉。`audio-check.py` 用 `ctypes` 直接调 CoreAudio：

```
IMMDeviceEnumerator → GetDefaultAudioEndpoint
  → IAudioSessionManager2 → GetSessionEnumerator
  → IAudioSessionControl2.GetProcessId / GetSessionInstanceIdentifier
  → IAudioMeterInformation.GetPeakValue
```

输出的 `instance` 字符串能直接看出是哪个可执行文件在发声（`...\CloudMusic\cloudmusic.exe` 还是 `#%b{...}`），峰值 > 0 即为真实输出。每一条"出声"结论都由它支撑，包括验证 `pause` 后峰值归零、`resume` 后恢复。
