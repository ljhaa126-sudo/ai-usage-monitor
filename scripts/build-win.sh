#!/usr/bin/env bash
# 构建 Windows 版（免安装，解压即用）：./scripts/build-win.sh
# 可选：有 go-winres（https://github.com/tc-hib/go-winres）时会把图标与版本信息写进 exe
source "$(dirname "$0")/common.sh"
NAME="AI Usage Monitor"
zipf="$(fetch_electron win32-x64)"
out="$DIST/win-x64"
rm -rf "$out"; mkdir -p "$out/$NAME"; cd "$out/$NAME"
unzip -q "$zipf"
mv electron.exe "$NAME.exe"
rm -f resources/default_app.asar
copy_app resources/app
if command -v go-winres >/dev/null; then
  sed "s/__VERSION__/$APP_VERSION/g" "$ROOT/scripts/res/winres.json" > "$ROOT/scripts/res/.winres.gen.json"
  go-winres patch --in "$ROOT/scripts/res/.winres.gen.json" --no-backup --authenticode remove "$NAME.exe"
  rm -f "$ROOT/scripts/res/.winres.gen.json"
else
  echo "（未找到 go-winres：exe 将使用 Electron 默认图标）"
fi
cp "$ROOT/docs/Windows版使用说明.txt" "$out/$NAME/使用说明.txt" 2>/dev/null || true
zip_dir "$out" "$NAME" "$DIST/AI用量监控-win-x64-v$APP_VERSION.zip"
