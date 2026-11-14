#!/bin/sh
# uninstall.sh — stop and remove the BeeM-Flash wireless bridge helper.
set -u
DIR=/var/opt/beem-bridge
if [ -f "$DIR/bridge.pid" ]; then
  kill "$(cat "$DIR/bridge.pid")" 2>/dev/null
  sleep 1
  kill -9 "$(cat "$DIR/bridge.pid")" 2>/dev/null
fi
rm -rf "$DIR" /run/beem-bridge
echo "beem-bridged stopped and removed. The access point is down."
