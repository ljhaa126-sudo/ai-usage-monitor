#!/usr/bin/env bash
# 公共变量与函数。构建不依赖 npm：直接使用 Electron 官方预编译包组装应用。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_VERSION="${ELECTRON_VERSION:-45.2.1}"
APP_VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/app/package.json'))['version'])")"
CACHE="$ROOT/.cache"
DIST="$ROOT/dist"
mkdir -p "$CACHE" "$DIST"

# 下载 Electron 官方包：fetch_electron darwin-arm64 | darwin-x64 | win32-x64 | linux-x64
fetch_electron() {
  local plat="$1" f="$CACHE/electron-v$ELECTRON_VERSION-$1.zip"
  if [ ! -s "$f" ]; then
    echo "下载 Electron $ELECTRON_VERSION ($plat)…" >&2
    curl -fSL --retry 3 -o "$f.part" "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-$plat.zip"
    mv "$f.part" "$f"
  fi
  echo "$f"
}

# 把应用源码复制到目标 resources/app（排除测试与缓存）
copy_app() {
  local dst="$1"
  mkdir -p "$dst"
  (cd "$ROOT/app" && tar cf - --exclude='.DS_Store' package.json main.js preload.js core renderer assets) | (cd "$dst" && tar xf -)
}

# 用 Python 打 zip：保留符号链接与可执行权限，文件名一律带 UTF-8 标记
zip_dir() {
  local src_parent="$1" name="$2" out="$3"
  rm -f "$out"
  python3 - "$src_parent" "$name" "$out" <<'PY'
import os, sys, stat, zipfile
parent, name, out = sys.argv[1:4]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(os.path.join(parent, name), followlinks=False):
        for d in list(dirs):
            p = os.path.join(root, d)
            if os.path.islink(p):
                dirs.remove(d); files.append(d)
        for f in files:
            p = os.path.join(root, f); arc = os.path.relpath(p, parent)
            info = zipfile.ZipInfo(arc)
            st = os.lstat(p)
            info.date_time = (2026, 1, 1, 0, 0, 0)
            if stat.S_ISLNK(st.st_mode):
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o755) << 16
                z.writestr(info, os.readlink(p))
            else:
                info.create_system = 3
                info.external_attr = (st.st_mode & 0xFFFF) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(p, "rb") as fh: z.writestr(info, fh.read())
print(out, os.path.getsize(out))
PY
}
