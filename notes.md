## 下载 / Download

| 系统 / System | 文件 / File |
|---|---|
| Mac（Apple 芯片：M1/M2/M3/M4…）| `AI用量监控-mac-arm64-v1.6.7.zip` |
| Mac（Intel）| `AI用量监控-mac-x64-v1.6.7.zip` |
| Windows 10 / 11（64 位）| `AI用量监控-win-x64-v1.6.7.zip` |

**Mac**：解压后把「AI Usage Monitor」拖进「应用程序」，在终端运行一次 / then run once in Terminal:
`xattr -cr "/Applications/AI Usage Monitor.app"`

**Windows**：解压到固定文件夹，双击 `AI Usage Monitor.exe`；如提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。

## 更新内容 / What's new

- **Windows 置顶修复**：有的电脑上悬浮条会被别的窗口盖住。原因有两个：
  ① Electron 在 Windows 上把 "floating" 级别放在任务栏后面，改用最高的 "screen-saver" 级别；
  ② 所有置顶窗口在同一层，谁最后被激活谁在上面，而悬浮条为了不抢焦点永远不会被激活，一旦被其他置顶程序（聊天软件悬浮窗、输入法工具栏、录屏、安全软件等）盖住就回不来。
  现在切换窗口、唤醒、解锁、换屏时，以及每 2 秒，会把它重新提到最上面（不抢焦点）。

