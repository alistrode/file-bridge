#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if [ -x ./runtime/file-bridge ]; then exec ./runtime/file-bridge --disable-setuid-sandbox "$PWD" "$@"; fi
if [ -x ./runtime/electron ]; then exec ./runtime/electron --disable-setuid-sandbox "$PWD" "$@"; fi
exec node scripts/start-dev.cjs "$@"
