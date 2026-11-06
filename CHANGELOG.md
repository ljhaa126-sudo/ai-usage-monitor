# 更新日志

## 1.7.12

- **Codex 重置次数恢复逐条显示**：鼠标悬停的气泡里，每次可用的重置单独一行，显示类型和到期时间（如「将于 12月5日 15:00 到期」，
  快到期时显示剩余小时数），每条都有自己的「立即重置」按钮，按到期先后排列。

## 1.7.11

- Codex 三种请求方式每种最多等 12 秒（以前 20 秒），三种都试完也在 40 秒内，网络不通时更快给出提示、更快重试。

## 1.7.10

- **修复气泡一直显示「正在更新…」**：启动时先显示上次保存的数据；如果之后刷新失败，以前会一直标着「正在更新…」，
  看不出其实在失败。现在会写明原因，例如「被 Cloudflare 拦截 · 去设置里登录网页版」或「更新失败（连接超时）· 稍后重试」。
- **单次刷新最多等 60 秒**：网络卡住时自动放弃并按计划重试，不会让某个 AI 从此不再刷新。
- **Fix**: bubbles no longer say "updating…" forever when refreshes fail; the reason is shown and stuck requests time out.

## 1.7.9

- **Codex 用量只取线上账号数据，不再用本机会话日志**：两台电脑都在用时，本机日志只记得这台电脑最后一次的额度，
  另一台电脑用过之后就不准。现在百分比、重置时间始终来自 ChatGPT 线上接口（账号级），在哪台电脑上看都一样。
- 这台电脑上 Codex 的登录过期（很久没在这台电脑上用 Codex）时，自动改用网页登录查线上用量。
- 线上暂时连不上 / 被 Cloudflare 拦截时，显示上一次的线上数据并提示，不再拿本机日志的旧数值顶替。
- 详细面板的 token 趋势图标注为「近 7 天 · 本机」（只统计这台电脑）。
- **Codex usage now always comes from the online account data** (accurate across multiple computers).

## 1.7.8

- **刘海屏适配只在刘海区域生效**：贴顶部时先按拖放的位置摆放；只有和刘海有重叠（图标可能被摄像头挡住）时，
  才以刘海为中心、图标分在两侧。放在刘海左边或右边就按原位置正常显示，不再强行挪到刘海。
- **Notch layout only applies when the bar is placed over the notch**; elsewhere along the top it stays where you put it.

## 1.7.7

- **macOS 贴顶部时放进菜单栏**：横向组件贴着屏幕最上沿（菜单栏里），不再停在菜单栏下方；层级高于菜单栏。
- **刘海屏适配**：有刘海的 MacBook 上，自动向系统读取刘海的准确位置和宽度，组件以刘海为中心、图标平分在刘海两侧，
  纯黑的组件和刘海连成一体。设置 → 外观 →「刘海屏适配」可以关闭（关闭后按原位置摆放）。没有刘海的屏幕只是放进菜单栏。
- **macOS top dock now sits inside the menu bar**, and on notched MacBooks it wraps around the notch.

## 1.7.6

- **显示「已用」或「剩余」**：设置 → 外观 →「显示方式」。圆环、百分比、气泡和详细面板都按所选显示，
  「已用 25 / 200」会换算成「剩余 175 / 200」；颜色始终按已用量变化，快用完时仍然变红。
- **只显示进度**：设置 → 外观 →「只显示进度」。竖条上只显示圆环（不显示百分比和金额），更紧凑；气泡里只显示进度条和重置时间。
- **吸附到屏幕顶部，变成横向**：把竖条拖到屏幕顶部松手，或在设置 / 托盘菜单里选「贴顶部（横向）」。
  两端同样是和屏幕边缘相接的内凹弧，气泡和提醒在下方弹出、尾巴朝上。
- **Show used or remaining**, **progress-only mode** (no numbers), and **top dock** with a horizontal bar.

## 1.7.5

- **支持 DeepSeek Harness（dsh）**：自动读取 `$DSH_HOME`（默认 `~/.dsh`）里 `.credentials.yaml` 的 DeepSeek API Key，
  以及第三方 Windows 桌面版 DSH Desktop 的 `~/.dsh-desktop/config.json`；装了 dsh 但读不到 Key 时显示「检测到」。
- **DeepSeek Harness (dsh)** API keys are now detected automatically.

## 1.7.4

- **修复 Copilot 误识别**：只是登录过 GitHub（VS Code 自带 Copilot）而自动开通、从没用过的免费版不再显示；
  套餐里没有的额度（额度为 0）不再显示成「已用 100%」；GitHub CLI 的令牌只在本机确实装了 Copilot 时才用。
- **DeepSeek 识别范围扩大**：除环境变量 / shell 配置 / Claude Code / cc-switch 外，还会读取
  Continue、OpenCode、Aider、家目录 .env、新版 cc-switch 数据库，以及 Cherry Studio、Chatbox、LobeHub 等桌面客户端里保存的 DeepSeek Key。
  只认 DeepSeek 名下的 Key（不会把别家的 Key 发给 DeepSeek）；找到多个时逐个验证，用有效的那个。
- **Fix**: unused auto-enabled Copilot Free no longer shows as 100%; DeepSeek keys are found in many more tools and clients.

## 1.7.3

- **竖条图标新增内圈**：外圈是当前会话（5 小时）用量，内圈是本周 / 总用量，颜色同样按用量从绿到红。
  只有同时有这两种额度的 AI（如 Claude、Codex）才显示内圈。设置 → 外观 →「显示内圈（本周 / 总用量）」可以开关。
- **Inner ring** on bar icons for weekly / total usage (outer ring = current session); toggle in Settings.

## 1.7.2

- **修复：重新打开 Claude / Codex 后，已经完成的旧任务陆续弹窗**。
  原因：重新打开时旧会话会被复制成新文件（恢复会话）或被重写，以前会把整段旧对话当成新任务重放。
  现在按日志里每一行的写入时间判断，超过 2 分钟的旧内容只用来建立状态，不会触发提醒；文件被重写时状态清零。
- Claude / ChatGPT 普通聊天：旧对话重新排到最近列表前面（重新打开后同步、改名、收藏）时不再提醒；
  只有 10 分钟内写完的回复、或者看到你发出消息的对话才提醒。
- **Fix**: reopening Claude / Codex no longer replays already-finished tasks as new alerts.

## 1.7.1

- **新增 DeepSeek**：显示开放平台账户余额（竖条上直接显示金额，如 ¥86.50；余额用完圆环变红）。
  自动从环境变量 DEEPSEEK_API_KEY、shell 配置文件、Claude Code / cc-switch 里接入 DeepSeek 的配置找 API Key。
- **新增腾讯混元**（腾讯云 TokenHub · Token Plan 套餐额度）：
  按腾讯云规定，额度只能用腾讯云 API 密钥（SecretId / SecretKey）查询，调用模型的 API Key 查不了。
  自动读取 tccli、腾讯云 SDK 凭据文件和环境变量 TENCENTCLOUD_SECRET_ID / KEY；只找到混元调用 Key 时显示「检测到」并提示补充密钥。
- **New providers**: DeepSeek (account balance) and Tencent Hunyuan (TokenHub Token Plan quota, via Tencent Cloud API credentials).

## 1.7.0

- **设置界面配合自动识别重新整理**（AI 账号部分）：
  - 已接入的 AI 显示「已自动接入」和数据来源（例如「来源：Claude Code 登录」）。
  - 检测到但读不到登录的 AI 显示「检测到…，还读不到登录」，旁边直接给「登录」按钮（只需一次）。
  - 本机没有检测到的 AI 收进底部「本机没有检测到的 AI」一行，需要时再展开。
  - 网页登录按钮、Key 输入框收进每个 AI 的「手动设置」，只在自动识别不到时才用；不再出现「API Key（必填）」。
- **腾讯内部 AI 也自动识别**：BoxAI（读取 Box 客户端里的 RTX 账号）、AI Token 用量 / token.woa.com（读取「用量健康助手」的登录）。
  不在公司网络时提示「需要连接公司内网或打开 iOA」，连上后自动恢复。
- **Settings reorganized for auto-detection**: connected / detected-needs-login / not-detected groups; manual options are tucked away.
- Tencent-internal BoxAI and token.woa.com are detected automatically as well.

## 1.6.9

- **任务彻底完成才提醒**（修复 Codex 会话进行中不停弹窗）：
  - 新版 Codex 的子代理（并行子任务、审查、压缩上下文）每完成一步都会写「完成」，以前被当成任务完成弹窗；现在全部忽略，只看主任务。
  - 一个请求只提醒一次：Codex / Claude 自己接着跑的后续几轮不再重复弹窗，等你发出下一个请求。
  - 「完成」后要安静 6 秒才确认，期间有任何新动作（执行命令、继续输出）就取消；Claude Code 子代理的输出也不算。
  - 「需要你处理」（批准操作、回答问题）照常立即提醒。
- **自动识别本机的 AI，不用手动配置**：
  - 启动时扫描，之后每 60 秒一次，主目录 / 应用程序目录有变化时几秒内再扫；之后新装或第一次登录的 AI 自动接入，并弹出「已自动接入」。
  - 只装了 Claude 桌面版：自动读取桌面版保存的登录（macOS 首次会弹出钥匙串授权，选「始终允许」），不用再点「登录网页版」。
  - Kimi / 智谱 GLM：自动从环境变量、shell 配置文件、Claude Code 设置、cc-switch、Claude Code Router、Kimi CLI 的配置里找 API Key。
  - Copilot：也会读取 GitHub CLI（gh）的登录。
  - 装了但读不到登录的 AI：提示一次「检测到 X，点击登录」，之后不再打扰。
- **Only notify when a task is fully done**: Codex sub-agents and auto-continued turns no longer trigger alerts mid-session.
- **Automatic AI detection**: installed / newly installed AIs are connected automatically, including the Claude desktop app login and Kimi / GLM keys already configured on the machine.

## 1.6.8

- **显示 / 隐藏悬浮条快捷键**：macOS `⌃⌥⌘U`（Control+Option+Command+U），Windows `Ctrl+Alt+Shift+U`。
  选三个修饰键的组合，避开系统和常见软件的快捷键；万一被别的软件占用，会自动换成备选（U → J → K）。
  设置 → 外观里可以录制自己的组合键，也可以关闭。托盘菜单里的「隐藏 / 显示悬浮条」旁边会显示当前快捷键。
- 包含 1.6.7 的 Windows 置顶修复：在装了其他置顶软件的电脑上，悬浮条不会再被盖住。
- 自动发布：推送新版本后，GitHub Actions 会自动构建 Mac（Apple 芯片 + Intel）和 Windows 安装包并发布 Release。
- **Hotkey to show / hide the bar**: `⌃⌥⌘U` on macOS, `Ctrl+Alt+Shift+U` on Windows (customizable in Settings).
- Windows: the bar now stays on top even when other always-on-top apps are running.

## 1.6.7

- **Windows 置顶修复**：有的电脑上悬浮条会被别的窗口盖住。原因有两个：
  ① Electron 在 Windows 上把 "floating" 级别放在任务栏后面，改用最高的 "screen-saver" 级别；
  ② 所有置顶窗口在同一层，谁最后被激活谁在上面，而悬浮条为了不抢焦点永远不会被激活，一旦被其他置顶程序（聊天软件悬浮窗、输入法工具栏、录屏、安全软件等）盖住就回不来。
  现在切换窗口、唤醒、解锁、换屏时，以及每 2 秒，会把它重新提到最上面（不抢焦点）。

## 1.6.6

- **普通聊天也提醒**：登录了网页版后，Claude（网页版 / 桌面版 / 手机）和 ChatGPT 的普通聊天回复写完也会弹出「已回复」提醒（`core/chatwatch.js`）。
- **启动前就在跑的任务**跑完也提醒；正在等你处理的任务，启动后直接提醒。
- **图标脉冲**：完成 / 需要处理一律显示脉冲（绿 / 橙）；只在鼠标移到图标上、点开提醒、切到任务所在窗口时消失；被自动隐藏的图标有脉冲时也显示。
- 提醒卡片底部显示具体去向（「点击切到 Terminal」「点击打开这个对话」）。

## 1.6.5

- **点提醒切到任务所在的软件**（以前 macOS 总是跳终端）：进程树定位 → 发消息时所在的软件 → 会话来源（桌面版 / 编辑器 / 终端）→ 默认规则。
- **Codex（GPT）HTTP 403**：三种请求方式自动切换并记住能用的（Node TLS + CLI 请求头 / 浏览器请求头 + 网页登录 Cookie / 旧方式），支持 HTTP / SOCKS5 系统代理；都被拦时用本地会话日志正常显示；新增 Codex「登录网页版」。

## 1.2 ～ 1.6.4

- 任务完成提醒（Codex / Claude Code / WorkBuddy / CodeBuddy / BoxAI）、点击提醒切换窗口、WorkBuddy / BoxAI 等数据源及其他改进（由其他 AI 迭代，详见代码注释）。

## 1.1.0（Electron 版：macOS + Windows）

- **修复闪烁**：刷新时不再把未连接的 AI 临时设为「读取中」；竖条只显示有数据的 AI；倒计时每秒只改文字，不重绘。
- **事件驱动刷新**：监听 Claude Code / Codex / Gemini CLI 会话文件和 Claude 桌面版本地数据，一有写入就在几秒内刷新。
- **智能频率**（默认开启）：使用中按设置的频率刷新，闲置时放慢到 2 分钟。
- **容错**：偶发的网络失败静默重试（指数退避加随机抖动），连续失败 3 次才提示；429 限流时自动退避。
- **休眠 / 锁屏暂停**，唤醒后自动恢复；断网时跳过。
- **快照**：重开程序立刻显示上次的数据。
- Codex 优先读本地会话日志，大幅减少联网。
- Windows 版：基于同一套代码；用 PowerShell DPAPI 解密 Cursor 令牌；深色标题栏；左键单击托盘图标也弹出菜单。
- 修正 Mac 安装说明中「已损坏」提示的处理方法。

## 1.0.0（Electron 版首发，macOS）

- 复刻参考图的贴边竖条：上下内凹弧与屏幕边缘相接，圆环颜色按用量变化，悬停弹出黑色气泡。
- 极简 / 详细两种展示样式；拖动吸附左右边缘或自由悬浮；支持多屏。
- 菜单栏托盘、设置窗口、「登录网页版」（Claude / Cursor），使用 Chrome 网络栈，自动跟随系统代理。

## 旧版（legacy/wails-windows，Go + Wails，已停止维护）

- 1.0～1.5：Windows 竖条小组件。期间修复过透明窗口黑边、窗口缩放卡死、系统代理、Cloudflare 403（uTLS）、HTTP/2 ALPN 乱码等问题。这些问题在 Electron 版中从架构上避免了，详见 AGENTS.md 的「踩过的坑」。
