#!/bin/sh
# uninstall.sh — stop and remove the BeeM-Flash connectivity probe. Run as root.
set -u
DIR=/var/opt/beem-probe
if [ -f "$DIR/probe.pid" ]; then kill "$(cat "$DIR/probe.pid")" 2>/dev/null; fi
# belt and suspenders: kill any stray instance
for p in $(pgrep -f beem-probe.js 2>/dev/null); do kill "$p" 2>/dev/null; done
rm -f /run/beem-probe/p.sock
rm -rf /run/beem-probe
rm -rf "$DIR"
echo "beem-probe stopped and removed. (It leaves nothing behind and touched nothing on the car.)"
