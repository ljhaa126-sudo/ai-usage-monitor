# AGENTS.md：给 AI 助手和新开发者的开发指南

在修改本项目前请先读完本文件。它记录了设计约束、代码约定，以及**已经踩过、不要再踩的坑**。

## 1. 项目一句话

Electron 桌面小组件：一个覆盖整块屏幕工作区的透明、点击穿透悬浮层，在屏幕边缘画一条黑色竖条，显示多个 AI 编程工具的用量。数据由主进程的刷新引擎获取，通过 IPC 推给界面。

## 2. 硬性约束

1. **零 npm 运行时依赖**。`app/` 只用 Node 内置模块和 Electron API。原因：最初的构建环境无法访问 npm registry，应用直接用 Electron 官方预编译包手工组装（见 `scripts/build-*.sh`）。新增依赖前，先确认构建环境能装；能用内置模块解决的不要加依赖。
2. **网络请求一律走 `core/http.js` 的 `requestJSON`**，它在 Electron 里使用 Chromium 网络栈（`net.request`）。不要改成 Node 的 `https` / `fetch`，原因有三：
   - 会失去系统代理支持（国内用户必需）；
   - 会失去 Chrome 的 TLS 指纹。claude.ai 等站点有 Cloudflare，Node 或 Go 的 TLS 指纹会被 403 拦截；
   - 会失去登录窗口留下的 Cookie（`useSessionCookies`）。
3. **只读不写**用户的其他工具的凭据文件（`~/.claude`、`~/.codex`、Cursor、Gemini 等）。不要刷新 Claude Code 的 OAuth 令牌并写回：刷新令牌会轮换，写回出错会让用户的 Claude Code 掉登录。
4. **界面文案为简体中文**，代码注释也用中文（项目主人是中文用户）。
5. 设计风格：纯黑 `#000`（不要用偏灰的 `#1c1c1e` 做大面积背景），配色见 `renderer/common.js` 的 `color()`：<50% 绿，<70% 黄，<90% 橙红，≥90% 红。图标统一用白色单色的通用图形，**不要放各家的商标 logo**。

## 3. 架构速览（详见 docs/ARCHITECTURE.md）

```
main.js ── Engine (core/engine.js) ── FETCHERS (core/providers.js) ── requestJSON (core/http.js)
   │            │                         └─ locallogs.js / secrets.js（本地文件、钥匙串、解密）
   │            └─ Store (core/store.js)：config.json / history.json / snapshot.json
   ├─ overlay 窗口（renderer/overlay.*）：全屏透明 + 点击穿透，竖条与气泡都是 DOM
   ├─ settings 窗口（renderer/settings.*）
   ├─ 登录窗口（BrowserWindow + session "persist:aimon"）
   └─ 托盘菜单
IPC：preload.js 暴露 window.aimon；主进程在 main.js 的 ipc() 里注册
```

## 4. 常见修改去哪里改

| 想做的事 | 改哪里 |
|---|---|
| 新增一个 AI | `core/providers.js`：在 `DEFS` 加一项，写 `fetchXxx`，加入 `FETCHERS`；`core/store.js` 的 `PROVIDER_IDS`；`renderer/common.js` 的 `GLYPH` 加图标；`renderer/settings.js` 的 `HINT`；`core/engine.js` 的 `MIN_GAP`；`test/providers.test.js` 加假响应 |
| 改竖条 / 气泡样子 | `renderer/overlay.css`、`overlay.js` 里的常量 `BW F R PAD GAP` 和 `pathEdge` / `pathFloat` |
| 改刷新策略 | `core/engine.js`：`interval()`、`refresh()` 的失败分支、`watch()` |
| 改设置项 | 在 `core/store.js` 的 `defaults()` 加默认值 → `renderer/settings.js` 加控件 → `main.js` 的 `updateCfg()` 处理副作用 |
| 改托盘菜单 | `main.js` 的 `buildMenu()` |

每个数据源返回的「状态对象」结构见 docs/ARCHITECTURE.md §5。新数据源必须按这个结构填 `primary` / `secondary` / `extra` 窗口。

## 5. 已经踩过的坑（重要）

1. **Windows 上不要用 Wails / WebView2 做透明窗口**（legacy/ 里的旧版）：WebView2 做不出真正的透明，空白处显示成大黑框；用 `SetWindowRgn` 裁形状、子类化窗口过程又引发卡死和白屏。Electron 的 `transparent: true` 在 Windows 和 macOS 上都正常，所以改用 Electron。
2. **悬浮层不要频繁改窗口大小**。现在的方案是：窗口固定覆盖整个工作区，竖条和气泡只是 DOM 元素，空白处 `setIgnoreMouseEvents(true, {forward:true})` 实现点击穿透，渲染层根据鼠标下的元素是否带 `.hit` 类来切换。拖动竖条只是移动 DOM，非常流畅。
3. **闪烁 bug**：刷新时把未连接的 AI 临时设为「读取中」，会让它在竖条上短暂出现又消失，竖条忽长忽短。规则是：`engine.refresh()` 不得在刷新开始时改动可见状态；开启「隐藏未连接」时，竖条只显示 `has(s)`（有数据）的项。
4. **不要每秒重绘整个气泡或面板**（会闪、丢失 hover 状态和滚动位置）。倒计时元素带 `data-cd` / `data-ago`，由 `tickText()` 每秒只改文字。
5. **偶发网络失败不要立刻报错**：国内网络经过代理、Mac 唤醒的头几秒都会偶尔失败。有旧数据时前两次失败静默（`lagging`），第 3 次或数据过旧才显示 `stale`。
6. **Go 版的教训**：用 uTLS 伪装 Chrome 指纹时，ALPN 不能带 h2，否则服务器回 HTTP/2 帧，而客户端按 HTTP/1.1 解析，会得到乱码。Electron 版用 Chromium 网络栈，没有这个问题。
7. **macOS 签名**：未公证的 App 下载后会被提示「已损坏」，这不是文件损坏。用户需执行 `xattr -cr "/Applications/AI Usage Monitor.app"`。Apple 芯片上必须至少 ad-hoc 签名，并保留 JIT 相关 entitlements（`scripts/res/ent.plist`）。改动 `Info.plist` 后必须重新签名。
8. **zip 打包**：macOS 包里有 framework 符号链接，必须保留（`scripts/common.sh` 的 `zip_dir` 已处理）；包内文件名用 ASCII，避免 Windows 资源管理器解压时乱码。
9. **Claude 桌面版的登录读不到**（加密存储、运行时被占用）。所以提供「登录网页版」窗口：Cookie 存在本程序自己的 `persist:aimon` 会话里。不要把 sessionKey 发到任何别的地方。
10. **钥匙串弹窗**：macOS 上读取 Claude Code 凭据（`security find-generic-password`）会弹授权框。只在 `~/.claude` 存在时才读，避免无意义的弹窗。

## 6. 测试与验证

```bash
./test/run-all.sh                    # 数据源解析 + 引擎行为 + 悬浮层界面（后者需 playwright）
./scripts/preview.sh /tmp/a.png "window.__test.showPop('claude')|/tmp/b.png;;window.__test.openCard('cursor')|/tmp/c.png"
python3 scripts/composite.py /tmp/b.png /tmp/b-view.png right   # 叠到壁纸上，方便查看
```

- `test/providers.test.js`：注入假 HTTP 响应和假本地文件，检查每个数据源的解析结果。改了解析逻辑后必须通过。
- `test/engine.test.js`：检查状态不来回闪、失败容错与退避、Codex 本地优先、智能频率、休眠暂停、快照恢复。
- `test/overlay.test.py`：竖条只显示有数据的项；倒计时每秒变化，但 DOM 不重建。
- 界面改动后用 `preview.sh` 截图自查（mock 数据在 `main.js` 的 `mockEngine()`）。

**注意：本项目至今没有在真实的 macOS / Windows 设备上做过系统测试**（构建环境是 Linux）。以下内容需要真机验证：托盘、点击穿透、拖动跨屏、钥匙串授权、Cursor 解密、登录窗口、休眠恢复。

## 7. 发布前检查清单

- [ ] `app/package.json` 版本号已更新，`CHANGELOG.md` 已补充
- [ ] `./test/run-all.sh` 全部通过
- [ ] 截图检查：右贴边、左贴边、自由悬浮、极简气泡、详细面板、设置页
- [ ] `./scripts/build-all.sh` 生成三个 zip；mac 包已签名（`rcodesign print-signature-info` 显示 ADHOC 和 allow-jit）
- [ ] 用户说明（`docs/*说明.txt`）与实际行为一致
