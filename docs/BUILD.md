# 构建与发布

本项目**不使用 electron-builder / npm 打包**，而是直接拿 Electron 官方预编译包，把 `app/` 放进 `resources/app`，再改名、换图标、签名、压缩。这样做不需要访问 npm，构建过程完全透明。

## 依赖工具

| 工具 | 用途 | 必需 |
|---|---|---|
| bash、curl、unzip、python3 | 下载与组装、打 zip | 是 |
| Pillow（`pip install pillow`） | 重新生成图标（`scripts/make-icons.py`） | 只在改图标时需要 |
| `rcodesign`（[apple-platform-rs](https://github.com/indygreg/apple-platform-rs/releases)） | 在 Linux 上给 mac 包做 ad-hoc 签名 | 在 Linux 上构建 mac 包时需要 |
| `codesign` | 在 macOS 上构建时使用系统自带签名工具 | macOS 自带 |
| `go-winres`（`go install github.com/tc-hib/go-winres@latest`） | 把图标和版本信息写进 Windows exe | 可选 |
| xvfb-run | Linux 上截图预览 | 只在预览时需要 |

Electron 版本由 `scripts/common.sh` 里的 `ELECTRON_VERSION` 指定（默认 45.2.1），也可以用环境变量覆盖。下载的包缓存在 `.cache/`。

## 命令

```bash
./scripts/build-mac.sh arm64      # 或 x64 / all
./scripts/build-win.sh
./scripts/build-all.sh            # 全部
```

产物：`dist/AI用量监控-mac-arm64-v{版本}.zip`、`dist/AI用量监控-mac-x64-v{版本}.zip`、`dist/AI用量监控-win-x64-v{版本}.zip`

版本号来自 `app/package.json`。

## macOS 签名与公证

- 当前是 **ad-hoc 签名**，没有开发者证书。Apple 芯片要求至少有 ad-hoc 签名，否则无法运行。entitlements 见 `scripts/res/ent.plist`（V8 的 JIT 需要）。
- 用户下载后会被 Gatekeeper 提示「已损坏」，需要执行一次 `xattr -cr "/Applications/AI Usage Monitor.app"`（说明见 `docs/Mac版安装说明.txt`）。
- **要做到双击即可打开**，需要 Apple Developer ID（每年 99 美元）：
  1. `codesign --force --deep --options runtime --timestamp --entitlements scripts/res/ent.plist -s "Developer ID Application: XXX" "AI Usage Monitor.app"`
  2. `xcrun notarytool submit app.zip --apple-id … --team-id … --wait`
  3. `xcrun stapler staple "AI Usage Monitor.app"`

  （`rcodesign` 也支持用证书签名和公证，可以在 Linux 上完成。）
- 修改 `Info.plist` 或 `Resources` 后必须重新签名，否则签名失效。

## Windows

- 发布形式是免安装的 zip，解压后运行 `AI Usage Monitor.exe`。
- exe 没有代码签名，首次运行时 SmartScreen 可能拦截：点「更多信息」→「仍要运行」。正式发布建议购买代码签名证书，用 `signtool` 签名；也可以做成安装包（NSIS 或 Inno Setup）。
- `go-winres patch` 会替换 exe 里的图标组 `#1` 和版本信息 `#1`（语言 0409），并去掉 Electron 原有的 Authenticode 签名。

## 预览与回归截图（Linux）

```bash
./scripts/preview.sh /tmp/a.png "window.__test.showPop('claude')|/tmp/b.png;;window.__test.openCard('codex')|/tmp/c.png" AIMON_DOCK='{"edge":"left"}'
python3 scripts/composite.py /tmp/b.png /tmp/view.png right
```

截图脚本格式：每步为 `JS代码|输出文件`，多步之间用 `;;` 分隔。
