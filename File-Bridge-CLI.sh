#!/bin/sh
set -eu
cd "$(dirname "$0")"
FB_NODE=./runtime/node
[ -x "$FB_NODE" ] || FB_NODE=node
exec "$FB_NODE" source/host/cli.cjs "$@"
