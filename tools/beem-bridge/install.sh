#!/bin/sh
# install.sh — install and start the BeeM-Flash wireless bridge helper.
#
# Run ONCE as root on the head unit. It lets a phone or laptop reach the car
# THROUGH the head unit: the helper owns the Wi-Fi access point and the DoIP
# listener, and BeeM-Flash decides what is allowed to reach the car.
#
# It writes no persistent system configuration, touches the vehicle bus never,
# and auto-exits after 30 minutes idle. Remove any time with uninstall.sh.
#
#   sh install.sh            # start it
#   sh install.sh --probe    # ONLY report whether this unit can host an AP
#
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR=/var/opt/beem-bridge
NODE="${NODE:-/usr/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; set NODE=/path/to/node and re-run"; exit 1; }

mkdir -p "$DIR"
cp "$SELF_DIR/beem-bridged.js" "$DIR/beem-bridged.js"

# --probe changes nothing: it just reports what this unit can do.
if [ "${1:-}" = "--probe" ]; then
  "$NODE" "$DIR/beem-bridged.js" --probe
  exit 0
fi

# stop any previous instance
if [ -f "$DIR/bridge.pid" ]; then kill "$(cat "$DIR/bridge.pid")" 2>/dev/null; sleep 1; fi

# start detached; survives this shell closing; logs to bridge.log
setsid "$NODE" "$DIR/beem-bridged.js" "$@" >"$DIR/bridge.log" 2>&1 &
echo $! > "$DIR/bridge.pid"
sleep 1
echo "=================================================================="
echo " beem-bridged started (pid $(cat "$DIR/bridge.pid"), node $NODE)"
echo " log: $DIR/bridge.log"
echo "=================================================================="
cat "$DIR/bridge.log"
echo
echo "NOW, on the car:"
echo "  1) BeeM-Flash -> CONNECT -> WIRELESS BRIDGE -> BRIDGE: OFF (tap to turn on)."
echo "  2) The screen shows the network name and password. Join it from the phone."
echo "  3) Point your tool at the address shown, port 13400 (DoIP)."
echo "  4) When done: sh uninstall.sh   (it also auto-exits after 30 min idle)"
