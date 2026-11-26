# NCMCLI — 网易云音乐终端播放器

在终端里选歌、播放你自己网易云账号里的音乐，**不打开客户端界面，也不依赖任何第三方音乐源**。

```
$ ncm list 5
your-account · 我喜欢的音乐 · 128 首

#    歌名                              歌手              专辑         时长
1    Sample Track One          Artist B      未知专辑     3:28
2    Sample Track Two                            Artist C            Sample Track Two       2:47
3    Sample Track Three                            Artist D          Sample Track Three       1:38
4    Sample Track Four                            Artist E            Sample Track Four       4:56
5    Sample Track Five           Artist F            Sample Track Five     3:30

$ ncm play 178
▶ #178 Sample Track — Artist A  [无损 1007k]

$ ncm now
▶ Sample Track — Artist A
  #178  [========>                 ]  1:12 / 4:07  85%  无损 1007k
  《Album X》
```

---

## 它是什么 / 不是什么

| | |
|---|---|
| **是** | 读你账号的歌单、按你账号的 VIP 权限取最高音质、本机硬件解码出声 |
| **不是** | 第三方音乐平台、抓取分享链接、破解版权 |

音源全部来自网易云官方 CDN（`m*.music.126.net`），直链由你自己的 `MUSIC_U` 换取，音质上限就是你账号的权限。

## 特性

- **零界面**：纯终端，客户端可以完全不开（进程都不需要）
- **读你自己的账号**：`/api/nuser/account/get` 拿 uid → 拿「我喜欢的音乐」→ 128 首完整列表
- **最高音质**：Hi-Res / 无损 FLAC / 320k 按账号权限自动降级
- **自动连播**：播完自动下一首，卡死自动跳过
- **登录态自检**：cookie 失效时会明确告诉你「是过期，不是没版权」
- **便携分发**：`pack.js` 打出的包自带 `node.exe`，目标机不需要装 Node

## 快速开始

### 方式 A：用分发包（对方没装 Node）

```
解压 → 双击 install.cmd → 新开终端 → ncm login → ncm list 20
```

`ncm login` 会自动找到网易云客户端、带调试端口重启它、抓取登录态——登录态本身不会丢。

### 方式 B：从源码（已装 Node ≥ 18）

```bash
git clone https://codeup.aliyun.com/69e6e1cef167bac7fd2561fe/NCMCLI.git
cd NCMCLI
node install.js          # 生成命令入口到 ~/bin 并加入 PATH
ncm login                # 绑定账号
ncm list 20
```

## 命令

| 命令 | 说明 |
|---|---|
| `ncm list [N\|all\|refresh]` | 歌单（默认 30 条，`all` 全量，`refresh` 强制刷新缓存） |
| `ncm play <序号>` | 播放歌单第 N 首 |
| `ncm search <关键词>` | 先搜歌单，无结果自动转全网搜索 |
| `ncm playid <歌曲ID>` | 播放全网搜到的歌 |
| `ncm now` | 当前曲目 + 进度条 + 实际音质 |
| `ncm pause` / `resume` / `toggle` | 暂停 / 继续 |
| `ncm next` / `prev` | 切歌 |
| `ncm vol [0-100]` | 设置 / 查看音量 |
| `ncm stop` | 停止播放 |
| `ncm login` | 抓取 / 刷新登录态 |
| `ncm quit` | 关闭后台 daemon |

## 音质

按 `hires → lossless → exhigh` 顺序请求，服务端按账号权限返回实际上限：

| 等级 | 典型码率 | 说明 |
|---|---|---|
| Hi-Res | 1600 kbps+ | 黑胶 VIP |
| 无损 | 900–1100 kbps | 黑胶 VIP |
| 极高 | 320 kbps | 普通 VIP / 部分免费 |
| 128 kbps | 128 kbps | 源文件本身只有这么高时 |

`play` 与 `now` 显示的 `[Hi-Res 1656k]` 是**实际拿到的**，不是请求值。

## 工作原理

```
 终端                 daemon (127.0.0.1:9334)             网易云                Windows
──────              ────────────────────────            ────────              ───────
ncm list    ──HTTP──▶  歌单缓存 / API 代理   ──weapi──▶  account/playlist
ncm play 5  ──HTTP──▶  取直链 + 排队         ──weapi──▶  player/url
                        │
                        └──stdin──▶ powershell/player.ps1 ──WPF MediaPlayer──▶ 扬声器
                                         ▲
                                       轮询 STATUS（进度/时长）→ 自动连播
```

`weapi` 加密（AES-128-CBC ×2 + RSA/BigInt）在 `daemon.js` 内实现，无第三方依赖。

## 项目结构

```
daemon.js       常驻播放服务：weapi、歌单缓存、队列、自动连播、登录态自检
ncm.js          命令行入口（HTTP 客户端），含 --experimental-websocket 自举
player.ps1      PowerShell 播放器：WPF MediaPlayer + stdin 控制协议
install.js      安装器：环境检查 + 生成命令入口 + PATH
install.cmd     Windows 双击入口
pack.js         打包器：生成不含登录态的分发包（自带 node.exe）
audio-check.py  CoreAudio 取证工具：读音频会话峰值，验证「真的出声」
```

## 依赖与平台

| 依赖 | 说明 |
|---|---|
| Windows 10 1803+ | 播放走 WPF / Windows Media Foundation |
| Node.js ≥ 18 | 分发包已内置，源码运行才需要 |
| curl.exe | Win10 1803+ 自带 |
| PowerShell 5.1 | 系统自带 |

## 常见问题

**cookie 会过期吗？**
会，但通常只有改密码或退出所有设备时才失效。失效时 `ncm play` 会明确报「登录态已失效（cookie 过期）」并给出修复方法，`ncm now` 顶部也会有 `[!]` 提示。

**某首歌报「无可用音源」？**
该曲目在你账号权限下没有版权，或已被下架。这与 cookie 无关（daemon 会回头查账号接口来区分两者）。

**要开着网易云客户端吗？**
不需要。客户端只在 `ncm login` 那一次用得到。

**能同时装多份吗？**
可以。daemon 在 `/status` 里会报自己的目录，CLI 发现端口被另一份拷贝占用时会自动让它退出再接管。

## 说明

仅供个人在自己的账号上播放自己账号有权播放的内容。请勿用于分发、二次上传或规避版权限制。
