#!/bin/sh
# Запуск тестів через Node.js, вбудований у VS Code (окремий Node не потрібен).
# Використання: sh test/run.sh
DIR=$(cd "$(dirname "$0")" && pwd)
NODE_BIN=$(command -v node)
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
  export ELECTRON_RUN_AS_NODE=1
fi
NODE_PATH="$DIR/mock" "$NODE_BIN" "$DIR/api.test.js"
