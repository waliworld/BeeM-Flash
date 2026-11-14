#!/bin/sh
# uninstall.sh — stop and remove the BeeM-Flash bridge helper. Run as root.
set -u
DIR=/var/opt/beem-bridge
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop beem-bridged.service 2>/dev/null
  systemctl disable beem-bridged.service 2>/dev/null
  rm -f /etc/systemd/system/beem-bridged.service
  systemctl daemon-reload 2>/dev/null
fi
if [ -f "$DIR/bridge.pid" ]; then kill "$(cat "$DIR/bridge.pid")" 2>/dev/null; sleep 1; kill -9 "$(cat "$DIR/bridge.pid")" 2>/dev/null; fi
rm -rf "$DIR" /run/beem-bridge
echo "beem-bridged stopped and removed. The access point is down."
