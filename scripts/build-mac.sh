#!/usr/bin/env bash
# 构建 macOS 版：./scripts/build-mac.sh [arm64|x64|all]
# 在 macOS 上用系统自带 codesign 做 ad-hoc 签名；在 Linux 上用 rcodesign（https://github.com/indygreg/apple-platform-rs）
source "$(dirname "$0")/common.sh"
APP="AI Usage Monitor.app"
build() {
  local arch="$1" zipf out
  zipf="$(fetch_electron "darwin-$arch")"
  out="$DIST/mac-$arch"
  rm -rf "$out"; mkdir -p "$out"; cd "$out"
  unzip -q "$zipf"
  mv Electron.app "$APP"
  local R="$APP/Contents/Resources"
  rm -f "$R/default_app.asar"
  copy_app "$R/app"
  cp "$ROOT/scripts/res/app.icns" "$R/electron.icns"
  python3 - "$APP/Contents/Info.plist" "$APP_VERSION" <<'PY'
import plistlib, sys
p, v = sys.argv[1], sys.argv[2]
d = plistlib.load(open(p, "rb"))
d.update({"CFBundleName": "AI 用量监控", "CFBundleDisplayName": "AI 用量监控", "CFBundleIdentifier": "com.aiusage.monitor",
          "CFBundleShortVersionString": v, "CFBundleVersion": v, "LSUIElement": True, "LSMinimumSystemVersion": "12.0",
          "NSHumanReadableCopyright": "AI 用量监控", "LSApplicationCategoryType": "public.app-category.developer-tools"})
d.pop("ElectronAsarIntegrity", None)
plistlib.dump(d, open(p, "wb"))
PY
  local ENT="$ROOT/scripts/res/ent.plist" H="Contents/Frameworks"
  if [ "$(uname)" = "Darwin" ]; then
    codesign --force --deep --sign - --entitlements "$ENT" "$APP"
  else
    command -v rcodesign >/dev/null || { echo "需要 rcodesign（Linux 上做 ad-hoc 签名）"; exit 1; }
    rcodesign sign -e "$ENT" -e "$H/Electron Helper.app:$ENT" -e "$H/Electron Helper (Renderer).app:$ENT" \
      -e "$H/Electron Helper (GPU).app:$ENT" -e "$H/Electron Helper (Plugin).app:$ENT" "$APP" >/dev/null
  fi
  zip_dir "$out" "$APP" "$DIST/AI用量监控-mac-$arch-v$APP_VERSION.zip"
}
case "${1:-all}" in
  arm64|x64) build "$1" ;;
  all) build arm64; build x64 ;;
  *) echo "用法：$0 [arm64|x64|all]"; exit 1 ;;
esac
