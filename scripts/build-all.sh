#!/usr/bin/env bash
# 一次构建 macOS（arm64 + x64）和 Windows（x64）
set -euo pipefail
D="$(dirname "$0")"
"$D/build-mac.sh" all
"$D/build-win.sh"
ls -la "$(cd "$D/.." && pwd)/dist"/*.zip
