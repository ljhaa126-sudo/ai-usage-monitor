# 已知问题与可优化方向

按建议优先级排列，供后续开发（包括其他 AI）参考。

## 需要真机验证（最高优先级）

构建环境是 Linux，以下功能只做过代码层面和模拟测试，**没有在真实的 macOS / Windows 上跑过**：

- [ ] 悬浮层点击穿透（`setIgnoreMouseEvents` 的 forward 模式），特别是 Windows 上的表现
- [ ] 拖动跨屏、吸附动画、多显示器分辨率变化
- [ ] 托盘菜单（Windows 左键 / 右键）、macOS 菜单栏标题百分比
- [ ] 钥匙串授权弹窗（Claude Code、Cursor Safe Storage）
- [ ] Windows 上 PowerShell DPAPI 解密 Cursor 令牌
- [ ] 登录网页版窗口：Claude 的邮箱登录流程、Cloudflare 验证、登录后自动关闭
- [ ] 休眠唤醒后的恢复
- [ ] 全屏应用上的显示（macOS `visibleOnFullScreen`）

## 功能

- [ ] **自动读取 Claude 桌面版登录**：macOS 上需要钥匙串里的 `Claude Safe Storage` 密钥来解密 `~/Library/Application Support/Claude/Cookies` 中的 `sessionKey`；Windows 上的思路见 `legacy/wails-windows/providers.go` 的 `claudeDesktopSessionKey`（DPAPI + AES-GCM，按字节扫描 SQLite）。桌面版运行时 Cookie 文件可能被占用。
- [ ] 额度达到阈值（例如 80% / 95%）时发系统通知（Electron `Notification`）
- [ ] 每个 AI 支持多账号（例如两个 Codex 账号）
- [ ] 英文界面（目前文案写死为中文，可抽取到字典）
- [ ] 竖条宽度、透明度、图标大小可调
- [ ] 自动更新（electron-updater 需要 npm；也可以自己实现：比对 GitHub Release 版本号后提示下载）
- [ ] 更多数据源：OpenRouter、DeepSeek、Windsurf、Augment、Amp 等（参考 CodexBar 的实现）
- [ ] 支持 Linux（代码基本可用，需要验证托盘和透明窗口在各桌面环境下的表现）

## 体验与工程

- [ ] macOS 公证与 Windows 代码签名（见 BUILD.md），消除首次打开时的拦截
- [ ] Windows 安装包、开始菜单快捷方式
- [ ] 悬浮层全屏透明窗口在 4K / 多屏下的 GPU 占用测量；必要时空闲时降低重绘
- [ ] 用量历史可导出（CSV）
- [ ] 无障碍：键盘操作、屏幕阅读器标签
- [ ] 把渲染层的 HTML 字符串拼接改为小型组件化（目前规模不大，暂时可以接受）

## 已知限制

- 各家接口是非公开的，可能失效；Cloudflare 规则变化时，网页登录方式可能需要重新验证。
- 「本周已重置 N 次」是程序在本机观测到的 5 小时窗口重置次数，程序没运行期间发生的重置不会计入。
- 非 token 类 AI 的「近 7 天」是每日最高使用率，从程序开始运行后才开始累计。
