#!/bin/sh
set -eu
cd "$(dirname "$0")"
FB_NODE=./runtime/node
[ -x "$FB_NODE" ] || FB_NODE=node
FB_CF=./runtime/cloudflared
[ -x "$FB_CF" ] || FB_CF=cloudflared
exec "$FB_NODE" source/host/cli.cjs start --cloudflared "$FB_CF" "$@"
