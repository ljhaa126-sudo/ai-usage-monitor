# legacy/wails-windows（已停止维护）

最早的 Windows 版本：Go + Wails v2（WebView2），对应用户收到过的 v1.0～v1.5「AI用量监控.exe」。

**已被 `app/`（Electron，macOS + Windows 共用一套代码）取代，不要在这里继续开发。**

保留它的原因：

- `providers.go` 的 `claudeDesktopSessionKey` / `scanSessionKey`：Windows 上读取 Claude 桌面版 Cookie 的思路（DPAPI 解出主密钥，AES-GCM 解密，按字节扫描 SQLite），将来给 Electron 版加「自动读取 Claude 桌面版登录」时可以参考。
- 踩坑记录（WebView2 不能真正透明、窗口缩放跨线程调用卡死、uTLS 的 ALPN 问题），见根目录 AGENTS.md。

构建（需要 Go 1.24 和 Wails v2.10）：
`GOOS=windows go build -tags desktop,production -ldflags "-s -w -H windowsgui" .`
