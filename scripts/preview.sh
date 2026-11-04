#!/usr/bin/env bash
# 在 Linux 上用 xvfb 运行应用（演示数据）并截图，用于检查界面。
# ./scripts/preview.sh out.png ["JS动作|截图文件;;JS动作|截图文件"] [环境变量...]
# 例：./scripts/preview.sh /tmp/a.png "window.__test.showPop('claude')|/tmp/b.png"
source "$(dirname "$0")/common.sh"
OUT="$1"; SCRIPT="${2:-}"; shift || true; shift || true
LZ="$(fetch_electron linux-x64)"; LD="$CACHE/electron-linux-x64"
[ -x "$LD/electron" ] || { mkdir -p "$LD"; unzip -q -o "$LZ" -d "$LD"; }
rm -rf /tmp/aimon-preview
cd "$ROOT/app"
env "$@" AIMON_MOCK=1 AIMON_DATA=/tmp/aimon-preview AIMON_SHOT="$OUT" AIMON_SHOT_SCRIPT="$SCRIPT" \
  timeout 90 xvfb-run -a -s "-screen 0 1440x900x24" "$LD/electron" --no-sandbox --disable-gpu . 2>&1 | grep -iv "dbus\|fontconfig\|vaapi\|NODE_OPTION" | head -5 || true
echo "截图：$OUT（透明背景，可用 scripts/composite.py 叠到壁纸上查看）"
