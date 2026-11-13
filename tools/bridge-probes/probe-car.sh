#!/bin/sh
# probe-car.sh — settle the make-or-break unknowns for the BeeM-Flash wireless
# bridge. Run as ROOT on the head unit (SSH or serial). READ-ONLY except for one
# temporary listening socket and (optionally) one temporary firewall rule, both
# removed before it exits. It sends NOTHING to the car. Safe to run with the
# engine off and the car parked.
#
# It answers two questions the repos cannot:
#   P2  what network interfaces/routes/firewall the head unit has
#   P3  whether a phone on the hotspot can reach a listener on the head unit
#
# Usage:  sh probe-car.sh            # P2 + P3 (listener test)
#         PORT=13400 sh probe-car.sh
set -u
PORT="${PORT:-13400}"
echo "=================================================================="
echo " BeeM-Flash bridge probe  —  read-only, sends nothing to the car"
echo "=================================================================="

echo; echo "### P2: network topology ###"
echo "--- interfaces (look for wlan0 = phone hotspot, and socnet0 = car) ---"
ip -br addr 2>/dev/null || ifconfig -a 2>/dev/null
echo "--- routes ---";       ip route 2>/dev/null
echo "--- policy rules ---"; ip rule 2>/dev/null
echo "--- listening TCP ports already open ---"; ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null
echo "--- firewall (default policy decides if an inbound rule is needed) ---"
nft list ruleset 2>/dev/null | head -40 || iptables -S 2>/dev/null || echo "(no nft/iptables visible)"

# Find the hotspot address to bind to (wlan0 preferred).
WIP="$(ip -4 -o addr show wlan0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
echo; echo "wlan0 IPv4 address: ${WIP:-<none found>}"

echo; echo "### P3: can a phone on the hotspot reach a listener here? ###"
if [ -z "$WIP" ]; then
  echo "No wlan0 address — connect your phone's hotspot (or the HU to the phone"
  echo "hotspot) so wlan0 gets an address, then re-run. Skipping the listener test."
else
  echo "Binding a throwaway TCP listener on ${WIP}:${PORT} for 60 seconds."
  echo ">>> On your PHONE (same hotspot), open a terminal / a TCP app and run:"
  echo ">>>     nc ${WIP} ${PORT}      (then type something and press enter)"
  echo ">>> If text arrives below, inbound Wi-Fi reachability is PROVEN."
  echo
  # Try to add a scoped accept rule if nft is present (removed afterwards).
  RULE_ADDED=0
  if command nft >/dev/null 2>&1 && nft list ruleset >/dev/null 2>&1; then
    if nft add rule inet filter input iifname "wlan0" tcp dport ${PORT} accept 2>/dev/null; then
      RULE_ADDED=1; echo "(added a temporary nft accept rule for wlan0 tcp/${PORT})"
    fi
  fi
  # Prefer nc; fall back to a tiny node listener.
  if command nc >/dev/null 2>&1; then
    ( nc -l -p ${PORT} -s "${WIP}" 2>/dev/null || nc -l "${WIP}" ${PORT} 2>/dev/null ) &
    LPID=$!
  elif command node >/dev/null 2>&1; then
    node -e "var n=require('net');n.createServer(function(s){s.on('data',function(d){process.stdout.write('[phone->HU] '+d);s.write('ok from head unit\n');});}).listen(${PORT},'${WIP}',function(){});setTimeout(function(){process.exit(0);},60000);" &
    LPID=$!
  else
    echo "Neither nc nor node found to open a listener."; LPID=
  fi
  [ -n "${LPID:-}" ] && { sleep 60; kill "$LPID" 2>/dev/null; }
  [ "$RULE_ADDED" = 1 ] && nft delete rule inet filter input iifname "wlan0" tcp dport ${PORT} accept 2>/dev/null && echo "(removed the temporary nft rule)"
fi

echo; echo "=================================================================="
echo " INTERPRETATION"
echo "  P3 text arrived          -> inbound reachable. Bridge leg is GO."
echo "  arrived only WITH the nft rule -> reachable, firewall insert needed."
echo "  nothing arrived either way -> AP client-isolation or no inbound path."
echo "       Try USB tether instead, or the bridge can't be wireless on this unit."
echo "=================================================================="
