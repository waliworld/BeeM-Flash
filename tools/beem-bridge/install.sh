#!/bin/sh
# install.sh — install the BeeM-Flash wireless bridge helper on the head unit.
#
# RUN AS ROOT (use your root-shell / SSH-root tool). It installs the helper the
# same way the MGU's own renderer daemon is installed: files under /var/opt and,
# where systemd is present, a unit so it starts at boot and restarts on failure.
#
#   sh install.sh            # install + start (systemd if available, else detached)
#   sh install.sh --probe    # ONLY report whether this unit can host an AP; changes nothing
#   sh install.sh --no-systemd   # force the detached (setsid) mode
#
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR=/var/opt/beem-bridge
NODE="${NODE:-/usr/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null)"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; set NODE=/path/to/node and re-run"; exit 1; }

if [ "$(id -u)" != "0" ]; then
  echo "This must run as root (it creates a Wi-Fi access point and a privileged listener)."
  echo "Use your root shell / SSH-root tool, then: sh install.sh"
  exit 1
fi

mkdir -p "$DIR"
cp "$SELF_DIR/beem-bridged.js" "$DIR/beem-bridged.js"

# --probe changes nothing; just report capability.
if [ "${1:-}" = "--probe" ]; then
  "$NODE" "$DIR/beem-bridged.js" --probe
  exit 0
fi

USE_SYSTEMD=1
[ "${1:-}" = "--no-systemd" ] && USE_SYSTEMD=0
command -v systemctl >/dev/null 2>&1 || USE_SYSTEMD=0

if [ "$USE_SYSTEMD" = "1" ]; then
  UNIT=/etc/systemd/system/beem-bridged.service
  sed "s|__NODE__|$NODE|g" "$SELF_DIR/beem-bridged.service" > "$UNIT"
  systemctl daemon-reload
  systemctl enable beem-bridged.service >/dev/null 2>&1
  systemctl restart beem-bridged.service
  sleep 1
  echo "=================================================================="
  echo " beem-bridged installed as a systemd service (starts at boot)."
  echo " status:  systemctl status beem-bridged"
  echo " log:     journalctl -u beem-bridged -e"
  echo "=================================================================="
  systemctl --no-pager status beem-bridged.service 2>/dev/null | head -6
else
  # Detached fallback for units without systemd.
  if [ -f "$DIR/bridge.pid" ]; then kill "$(cat "$DIR/bridge.pid")" 2>/dev/null; sleep 1; fi
  setsid "$NODE" "$DIR/beem-bridged.js" >"$DIR/bridge.log" 2>&1 &
  echo $! > "$DIR/bridge.pid"
  sleep 1
  echo "=================================================================="
  echo " beem-bridged started (pid $(cat "$DIR/bridge.pid"), detached)."
  echo " log: $DIR/bridge.log   (NOTE: without systemd it will not restart at boot)"
  echo "=================================================================="
  cat "$DIR/bridge.log" 2>/dev/null | head -8
fi

echo
echo "NOW, on the car: BeeM-Flash -> CONNECT -> WIRELESS BRIDGE -> BRIDGE: ON."
echo "The screen shows the network name + password; join it from the phone, then"
echo "point your tool at the address shown, port 13400 (or 6801)."
