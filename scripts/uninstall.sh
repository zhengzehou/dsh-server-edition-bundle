#!/usr/bin/env sh
set -eu
MODE=--plan
PROFILE=web
if [ "${1:-}" = "--execute" ]; then MODE=--execute; shift; fi
if [ "${1:-}" = "--profile" ]; then PROFILE="$2"; shift 2; fi
node "$(dirname "$0")/../tools/uninstall.mjs" --profile "$PROFILE" "$MODE" "$@"
