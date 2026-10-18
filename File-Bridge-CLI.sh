#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if [ -x ./runtime/file-bridge ]; then ELECTRON_RUN_AS_NODE=1 exec ./runtime/file-bridge ./source/bridge/cli.cjs "$@"; fi
if [ -x ./runtime/electron ]; then ELECTRON_RUN_AS_NODE=1 exec ./runtime/electron ./source/bridge/cli.cjs "$@"; fi
exec node ./source/bridge/cli.cjs "$@"
