# 架构

## 1. 进程与窗口

| 组件 | 文件 | 说明 |
|---|---|---|
| 主进程 | `app/main.js` | 创建窗口、托盘、IPC；持有 `Store` 和 `Engine`；处理代理、休眠、多屏 |
| 悬浮层窗口 | `app/renderer/overlay.*` | 覆盖所在屏幕**工作区**（不含菜单栏 / 任务栏）的透明无边框窗口，置顶；macOS 上是 `type: 'panel'`、所有桌面空间可见、不可获得焦点 |
| 设置窗口 | `app/renderer/settings.*` | 普通窗口，纯黑主题；修改即时保存（没有「保存」按钮） |
| 登录窗口 | `main.js` 的 `openLogin()` | 加载 claude.ai / cursor.com 登录页，使用独立会话 `persist:aimon`，UA 伪装成 Chrome；登录成功（拿到 Cookie 并离开登录页）后自动关闭 |
| 托盘 | `main.js` 的 `buildMenu()` | macOS 用模板图标（自动适配深浅色），可在菜单栏显示最高用量百分比；Windows 左键点击也会弹出菜单 |

### 悬浮层的点击穿透

窗口始终是整个工作区那么大，默认 `setIgnoreMouseEvents(true, { forward: true })`，也就是点击穿透到下面的应用，但仍然能收到鼠标移动事件。渲染层监听 `mousemove`，用 `document.elementFromPoint` 判断鼠标下面是否是带 `.hit` 类的元素（竖条形状的 path、图标区、气泡、面板），只在状态变化时通过 IPC `ignore` 切换。竖条 SVG 外框的透明角落设置了 `pointer-events: none`，所以不会挡住下面的点击。

### 竖条几何（overlay.js 顶部常量）

- `BW=74` 宽度，`F=26` 贴边时上下内凹弧半径，`R=30` 外侧圆角，`PAD=24` 内边距，`GAP=15` 竖条与气泡的距离（气泡尾巴画在这段空隙里）。
- 贴边形状由 `pathEdge()` 生成：外侧两个圆角，加上上下两段与屏幕边缘相接的内凹弧。贴左边时用 `scaleX(-1)` 镜像。
- 自由悬浮形状由 `pathFloat()` 生成：胶囊。
- 位置存为工作区内的**比例** `dock = { mode: 'edge'|'float', edge: 'left'|'right', x, y, displayId }`，分辨率变化后位置依然合理。

### 拖动与吸附

在竖条上按下，移动超过 5px 才算拖动（否则视为点击）。拖动时竖条变成胶囊并跟随鼠标；松手时如果离左右边缘不到 70px 就吸附到该边，否则自由悬浮。松手的屏幕坐标会发给主进程，如果落在另一块屏幕上，主进程会把悬浮层整体搬过去（`drag-end`）。

### 气泡与面板

- **极简**：悬停 90ms 后显示气泡，离开 260ms 后隐藏，点击可固定。气泡展示 `rows(s)`：`primary` 和 `secondary`，不够两条时用 `extra` 补足。
- **详细**：点击图标打开 360px 宽的面板。
- 两者都由 `placeBubble()` 定位：贴右边时放在竖条左侧，贴左边时放在右侧，自由悬浮时朝向屏幕中央；纵向对齐所点图标，并限制在屏幕内；尾巴指向图标。
- 倒计时：带 `data-cd`（重置时间戳）和 `data-fmt`（`reset`：一天以内显示倒计时，更远显示「周四 00:00 重置」；`left`：始终倒计时）的元素，由 `tickText()` 每秒只改文字。

## 2. 刷新引擎（core/engine.js）

每秒执行一次 `tick()`：对每个启用的 AI，到了 `nextAt` 并且没有请求在进行中，就调用 `refresh(id)`。

```
interval(id) = smartRefresh && !active(id) ? max(base, 120s) : base
base = max(refreshSeconds, MIN_GAP[id])
active(id) = 启动后 2 分钟内 || 5 分钟内有本地活动 || 10 分钟内用量变化过
```

`refresh()` 的结果：

| 结果 | 新状态 | 下次刷新 |
|---|---|---|
| 成功 | `ok`，`fails = 0`，记录历史与快照 | `+interval` |
| `NoLogin` 异常 | `nologin`（没有凭据或凭据失效） | `+max(interval, 60s)` |
| 其他错误，且有旧数据 | 保留旧数据，`lagging = true`；`fails ≥ 3` 或数据早于 `max(3×interval, 5min)` 时变为 `stale` 并带上提示 | 退避 15s、30s、60s… 最多 5 分钟，429 限流最多 10 分钟，带 ±15% 随机抖动 |
| 其他错误，没有旧数据 | `error` | 同上 |

**事件驱动**（`watch()`）：对以下目录做递归 `fs.watch`，有写入时（防抖 1.5～5 秒）调用 `activity(id)`，标记为活跃并尽快刷新（仍遵守 `MIN_GAP`）。

- `~/.claude/projects`（Claude Code 会话，*.jsonl）
- `~/.codex/sessions`（Codex 会话）
- Claude 桌面版数据目录下的 IndexedDB / Local Storage（聊天时会写入）
- `~/.gemini/tmp`（Gemini CLI）
- Cursor `workspaceStorage`：只标记活跃，不立即刷新

**休眠与断网**：主进程把 `powerMonitor` 的 `suspend` / `lock-screen` 接到 `engine.pause()`，`resume` / `unlock-screen` 接到 `engine.resume()`（4～7 秒后刷新，并清零失败计数）。`ctx.isOnline()` 返回 false 时跳过本轮 tick。

**快照**：每次更新后（2 秒防抖）把有数据的状态写入 `snapshot.json`；下次启动时先显示（`fromCache: true`），12 小时以上的快照丢弃。

## 3. 存储（core/store.js）

数据目录：macOS `~/Library/Application Support/AI 用量监控/`，Windows `%APPDATA%\AI 用量监控\`。

| 文件 | 内容 |
|---|---|
| `config.json` | 配置（见下） |
| `history.json` | `days[id][YYYY-MM-DD] = {peak, n}`：每日最高使用率；`resets[id] = [ts…]`：观察到的 5h 窗口重置时间点，用于「本周已重置 N 次」 |
| `snapshot.json` | 上次成功的状态 |
| `log.txt` | 运行日志（超过 512KB 自动清空） |
| `Partitions/aimon/` | 登录窗口的 Cookie（Electron 加密存储） |

```jsonc
// config.json
{
  "providers": { "claude": { "enabled": true, "apiKey": "", "region": "cn" }, ... },
  "order": ["claude","codex","cursor","gemini","copilot","kimi","glm"],
  "refreshSeconds": 30,        // 5 | 10 | 30 | 60 | 300
  "smartRefresh": true,
  "style": "minimal",          // minimal | detail
  "hideIdle": true,            // 竖条只显示有数据的 AI
  "autoStart": false,
  "proxy": "",                 // 空 = 系统代理；direct = 不走代理；否则为代理地址
  "trayPercent": true,
  "dock": { "mode": "edge", "edge": "right", "x": 0.8, "y": 0.32, "displayId": 0 }
}
```

## 4. IPC（preload.js → window.aimon）

| 方法 | 方向 | 说明 |
|---|---|---|
| `state()` | 渲染→主 | `{list, cfg, version, platform}` |
| `onUpdate(fn)` / `onConfig(fn)` / `onWebStatus(fn)` | 主→渲染 | 状态列表 / 配置 / 网页登录状态推送 |
| `setIgnore(bool)` | 渲染→主 | 悬浮层点击穿透开关 |
| `refresh(id?)` | 渲染→主 | 立即刷新（不传 id 表示全部） |
| `saveConfig(patch)` | 渲染→主 | 合并保存配置并应用副作用（自启动、代理、重排刷新） |
| `login(id)` / `logout(id)` / `webStatus()` | 渲染→主 | 网页登录 |
| `dragEnd({screenX, screenY, dock})` | 渲染→主 | 保存位置；落到别的屏幕时搬移悬浮层 |
| `contextMenu()` / `openSettings()` / `openUrl(u)` / `openLog()` / `quit()` | 渲染→主 | — |

## 5. 状态对象（engine 输出、界面输入）

```js
{
  id, name, short, tagline, color, dashboard, login, keyKind, // 来自 DEFS
  enabled, state,          // loading | ok | stale | error | nologin | disabled
  message,                 // 给用户看的提示
  plan, account, source, credits, planEndsAt,
  primary:   Window | null,   // 短窗口，通常是 5 小时「当前会话」
  secondary: Window | null,   // 长窗口，通常是「所有模型 · 本周」；Cursor / Copilot 是本月
  extra:     Window[],        // 其他额度
  headline, headlineKey,      // 竖条上显示的百分比 = primary ?? secondary ?? extra[0]
  resetCount,                 // 本周期内 5h 窗口已重置次数（本机观测）
  history: [{date, value}],   // 近 7 天；historyUnit 为 "M tokens" 或 "峰值 %"
  activeDays: bool[7],        // 本周一到周日是否用过
  updatedAt, lagging, fromCache
}
Window = { key: "5h"|"week"|"day"|"month"|"other", label, usedPercent, resetsAt(ms), windowMinutes, detail }
```
