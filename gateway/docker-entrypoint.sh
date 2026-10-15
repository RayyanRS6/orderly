#!/bin/sh
# Gateway container entrypoint.
# - Normal path (Docker Compose, container smoke test): the image runs as the unprivileged
#   node user (uid 1000) and this script simply hands over to node.
# - Hosts that mount a root-owned volume (Railway with RAILWAY_RUN_UID=0) start it as root:
#   only the data directory is chowned, then privileges drop to node before the gateway runs.
# exec keeps node as the signalled process, so SIGTERM reaches its shutdown handler and the
# data-volume lease is released. Never print environment values here.
set -eu

[ "$#" -gt 0 ] || set -- node dist/gateway/src/index.js
data_dir="${GATEWAY_DATA_DIR:-/data}"

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$data_dir"
  chown -R node:node "$data_dir"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

if [ -d "$data_dir" ] && [ ! -w "$data_dir" ]; then
  echo "GATEWAY_DATA_DIR is not writable by uid $(id -u). On Railway, set RAILWAY_RUN_UID=0." >&2
fi
exec "$@"
