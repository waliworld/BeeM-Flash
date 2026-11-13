#!/bin/sh
# install.sh — install and start the BeeM-Flash connectivity probe on the head unit.
# Run ONCE as root (you already have shell access). It settles P1 (app<->daemon
# socket) and P3 (phone->head unit reachability). It sends NOTHING to the car and
# auto-exits after 30 minutes. Remove any time with uninstall.sh.
#
#   sh install.sh
#
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR=/var/opt/beem-probe
NODE="${NODE:-/usr/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; set NODE=/path/to/node and re-run"; exit 1; }

mkdir -p "$DIR"
cp "$SELF_DIR/beem-probe.js" "$DIR/beem-probe.js"

# stop any previous instance
if [ -f "$DIR/probe.pid" ]; then kill "$(cat "$DIR/probe.pid")" 2>/dev/null; sleep 1; fi

# start detached; survives this shell closing; logs to probe.log
setsid "$NODE" "$DIR/beem-probe.js" >"$DIR/probe.log" 2>&1 &
echo $! > "$DIR/probe.pid"
sleep 1
echo "=================================================================="
echo " beem-probe started (pid $(cat "$DIR/probe.pid"), node $NODE)"
echo " log: $DIR/probe.log"
echo "=================================================================="
cat "$DIR/probe.log"
echo
echo "NOW:"
echo "  1) On the car: BeeM-Flash -> SETUP -> DIAG -> RUN."
echo "     P1 should read OK for /run/beem-probe/p.sock."
echo "  2) From a phone/laptop on the SAME hotspot, run the 'nc ...' line shown"
echo "     above. If it echoes, P3 is a GO. Watch $DIR/probe.log to confirm."
echo "  3) When done:  sh uninstall.sh   (it also auto-exits after 30 min)"
