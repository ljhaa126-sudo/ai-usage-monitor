#!/usr/bin/env bash
# 运行全部测试：数据源解析、刷新引擎、悬浮层界面（后者需要 python3 + playwright，可选）
set -e
cd "$(dirname "$0")/.."
node test/providers.test.js
node test/engine.test.js
node test/v165.test.js "$PWD/app"
node test/chat.test.js "$PWD/app"
node test/done.test.js "$PWD/app"
node test/detect.test.js "$PWD/app"
node test/cn.test.js "$PWD/app"
node test/replay.test.js "$PWD/app"
node test/detect2.test.js "$PWD/app"
node test/notch.test.js "$PWD/app"
if python3 -c "import playwright" 2>/dev/null; then python3 test/overlay.test.py; else echo "（跳过界面测试：未安装 playwright）"; fi
