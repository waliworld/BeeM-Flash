'use strict';
//
// beem-probe.js — throwaway connectivity probe for the BeeM-Flash wireless bridge.
//
// Runs as root on the head unit. It settles two feasibility questions and NOTHING
// else — it has no path to the vehicle (no TASU, no UDS, nothing is sent to the car):
//
//   P1  a UNIX socket (/run/beem-probe/p.sock) the sandboxed app can connect to,
//       owned by the app group so SETUP -> DIAGNOSTICS shows "P1 ... OK".
//   P3  a TCP echo listener on the wlan0 address, so a phone/laptop on the same
//       hotspot can prove it can reach the head unit.
//
// It echoes text only, binds the Wi-Fi interface address (never 0.0.0.0), and
// AUTO-EXITS after a timeout so a forgotten probe closes itself. Remove any time
// with uninstall.sh. Node 8 compatible; no dependencies.
//
var net = require('net'), fs = require('fs'), os = require('os'), path = require('path');
var APP_GID = parseInt(process.env.BEEM_APP_GID || '12202', 10);   // tm_oap_app
var PORT = parseInt(process.env.BEEM_PORT || '13400', 10);
var TTL = parseInt(process.env.BEEM_TTL || '1800', 10) * 1000;     // auto-exit (default 30 min)
var SOCK_DIR = process.env.BEEM_SOCK_DIR || '/run/beem-probe';
var SOCK = path.join(SOCK_DIR, 'p.sock');

function log(m) { console.log('[' + new Date().toISOString() + '] ' + m); }
function cleanup() { try { fs.unlinkSync(SOCK); } catch (e) {} }

// --- P1: a UNIX socket the app can reach ---
try { fs.mkdirSync(SOCK_DIR); } catch (e) {}
cleanup();
var us = net.createServer(function (s) {
  s.on('data', function (d) { log('P1 UNIX <- app: ' + String(d).trim() + '  (the app reached the daemon — P1 PASS)'); try { s.write('pong\n'); } catch (e) {} });
  s.on('error', function () {});
});
us.on('error', function (e) { log('P1 UNIX socket error: ' + e.message); });
us.listen(SOCK, function () {
  try { fs.chmodSync(SOCK, 0o660); } catch (e) {}
  try { fs.chownSync(SOCK, 0, APP_GID); } catch (e) { log('P1 chown failed (the app may not be able to reach it): ' + e.message); }
  log('P1 UNIX socket ready: ' + SOCK + ' (group ' + APP_GID + ', mode 0660)');
});

// --- P3: TCP echo on the wlan0 address ---
function wlanAddr() {
  var ifs = os.networkInterfaces() || {}, names = Object.keys(ifs), i, j, a;
  for (i = 0; i < names.length; i++) if (/wlan/i.test(names[i])) { a = ifs[names[i]] || []; for (j = 0; j < a.length; j++) if ((a[j].family === 'IPv4' || a[j].family === 4) && !a[j].internal) return { iface: names[i], ip: a[j].address }; }
  if (process.env.BEEM_BIND_ANY_IFACE) for (i = 0; i < names.length; i++) { a = ifs[names[i]] || []; for (j = 0; j < a.length; j++) if ((a[j].family === 'IPv4' || a[j].family === 4) && !a[j].internal) return { iface: names[i], ip: a[j].address }; }
  return null;
}
var w = wlanAddr();
if (!w) {
  log('P3: no wlan0 IPv4 address — connect your phone hotspot so the head unit gets a Wi-Fi address, then restart the probe. (P1 is still up.)');
} else {
  var ts = net.createServer(function (s) {
    var peer = s.remoteAddress + ':' + s.remotePort;
    log('P3 TCP <- ' + peer + '   *** a device REACHED the head unit — this is the GO signal ***');
    try { s.write('BeeM-Flash probe: you reached the head unit at ' + w.ip + ':' + PORT + '\n'); } catch (e) {}
    s.on('data', function (d) { log('P3 TCP data from ' + peer + ': ' + String(d).trim()); try { s.write('echo: ' + d); } catch (e) {} });
    s.on('error', function () {});
  });
  ts.on('error', function (e) { log('P3 TCP listen error on ' + w.ip + ':' + PORT + ': ' + e.message); });
  ts.listen(PORT, w.ip, function () {
    log('P3 TCP echo listening on ' + w.ip + ':' + PORT + ' (' + w.iface + ').');
    log('    >>> from a phone/laptop on the SAME hotspot:   nc ' + w.ip + ' ' + PORT + '   (then type something)');
  });
}

log('beem-probe running — it sends NOTHING to the car. Auto-exit in ' + (TTL / 1000) + 's, or run uninstall.sh.');
setTimeout(function () { log('beem-probe auto-exit (timeout).'); cleanup(); process.exit(0); }, TTL);
process.on('SIGTERM', function () { log('beem-probe stopping (SIGTERM).'); cleanup(); process.exit(0); });
process.on('SIGINT', function () { cleanup(); process.exit(0); });
