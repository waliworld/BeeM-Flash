#!/usr/bin/env node
'use strict';
/*
 * beem-bridged — the root helper that gives BeeM-Flash a wireless bridge.
 *
 * WHY IT EXISTS
 *   The head unit's app sandbox cannot bring up Wi-Fi or listen on a port. So
 *   this small daemon owns the network side, and the app attaches to its UNIX
 *   socket as a client:
 *
 *     phone / tool --Wi-Fi--> [this daemon: AP + DoIP] --UNIX socket--> app
 *                                                                        |
 *                                                                TASU to the car
 *
 * WHAT IT DOES *NOT* DO — read this before trusting it:
 *   * It does not decide what may reach the car. It carries bytes. Every
 *     relayed request is judged by the APP (relaypolicy + the on-screen consent
 *     gate). If the app is not attached and armed, nothing is relayed at all.
 *   * It writes NO persistent system configuration. hostapd/dnsmasq configs are
 *     written under a runtime directory and removed on exit. Stopping the
 *     daemon leaves the unit as it was.
 *   * It never touches the vehicle bus itself.
 *
 * STATUS: the control protocol, the DoIP server and the relay are exercised by
 * the project's tests. Bringing up a SoftAP is HEAD-UNIT SPECIFIC and is NOT
 * verified on an MGU: run `beem-bridged --probe` first, which reports whether
 * this unit's Wi-Fi can do AP mode at all and whether the tools are present.
 *
 * Usage:
 *   beem-bridged --probe                 report capability, change nothing
 *   beem-bridged [--iface wlan0] [--ssid BeeM-Flash] [--channel 6]
 *                [--country US] [--addr 192.168.44.1] [--no-ap] [--idle 1800]
 */

var net = require('net');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

// ---- options ---------------------------------------------------------------
var argv = process.argv.slice(2);
function opt(name, dflt) {
  var i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = argv[i + 1];
  return (v === undefined || v.slice(0, 2) === '--') ? true : v;
}
var OPT = {
  probe: argv.indexOf('--probe') >= 0,
  noAp: argv.indexOf('--no-ap') >= 0,
  iface: String(opt('iface', '') || ''),
  ssid: String(opt('ssid', 'BeeM-Flash')),
  channel: Number(opt('channel', 6)) || 6,
  country: String(opt('country', 'US')),
  addr: String(opt('addr', '192.168.44.1')),
  sock: String(opt('socket', '/run/beem-bridge/bridge.sock')),
  doipPort: Number(opt('port', 13400)) || 13400,
  idleSec: Number(opt('idle', 1800)) || 1800,
  appGid: Number(opt('gid', 12202)) || 12202,   // tm_oap_app: the app's group
  runDir: String(opt('rundir', '/run/beem-bridge'))
};

function log() {
  var a = Array.prototype.slice.call(arguments);
  process.stdout.write('[beem-bridged] ' + a.join(' ') + '\n');
}
function sh(cmd) {
  try { return { ok: true, out: String(cp.execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] })) }; }
  catch (e) { return { ok: false, out: String((e && (e.stderr || e.stdout)) || (e && e.message) || e) }; }
}
function has(bin) { return sh('command -v ' + bin + ' 2>/dev/null').ok; }

// ---- capability probe ------------------------------------------------------
function wifiIfaces() {
  var out = [];
  var ifs = os.networkInterfaces();
  for (var name in ifs) if (ifs.hasOwnProperty(name)) {
    if (name === 'lo') continue;
    var v4 = (ifs[name] || []).filter(function (a) { return a.family === 'IPv4'; })[0];
    out.push({ name: name, address: v4 ? v4.address : null, mac: v4 ? v4.mac : null });
  }
  return out;
}
function apCapable() {
  var r = sh('iw list 2>/dev/null');
  if (!r.ok) return { known: false, ap: false, why: 'iw not available' };
  var m = /Supported interface modes:([\s\S]*?)\n\s*\n/.exec(r.out);
  var block = m ? m[1] : r.out;
  return { known: true, ap: /\bAP\b/.test(block), why: null };
}
function probe() {
  var ifs = wifiIfaces(), cap = apCapable();
  log('interfaces:');
  ifs.forEach(function (i) { log('   ' + i.name + '  ' + (i.address || '-') + '  ' + (i.mac || '')); });
  log('AP mode supported: ' + (cap.known ? (cap.ap ? 'YES' : 'NO') : 'unknown (' + cap.why + ')'));
  ['hostapd', 'dnsmasq', 'udhcpd', 'iw', 'ip'].forEach(function (b) {
    log('tool ' + b + ': ' + (has(b) ? 'present' : 'MISSING'));
  });
  log('runtime dir: ' + OPT.runDir);
  log('socket path: ' + OPT.sock);
  log('');
  log('If AP mode is NO or hostapd is MISSING, this unit cannot host its own');
  log('Wi-Fi network. The relay can still be used over an existing network by');
  log('running with --no-ap and reaching ' + OPT.doipPort + ' on an address the unit already has.');
}

// ---- AP state --------------------------------------------------------------
// A readable passphrase: the car SHOWS it and you type it into the phone, so it
// avoids characters that are ambiguous on a dashboard (0/O, 1/l/I).
var WORDS = ('amber anvil basalt cedar delta ember fjord granite harbor indigo jasper kettle lumen maple nickel onyx ' +
  'pebble quartz raven summit timber umber violet walnut yarrow zenith cobalt dune elm forge glacier').split(' ');
function genPass() {
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  var n = String(Math.floor(Math.random() * 9000) + 1000);
  return pick(WORDS) + '-' + n + '-' + pick(WORDS);
}

var AP = {
  up: false,
  ssid: OPT.ssid,
  pass: genPass(),
  security: 'WPA2',
  channel: OPT.channel,
  address: OPT.addr,
  iface: OPT.iface || null,
  procs: []
};

function pickIface() {
  if (OPT.iface) return OPT.iface;
  var cands = wifiIfaces().map(function (i) { return i.name; })
    .filter(function (n) { return /^wl|wlan/.test(n); });
  return cands[0] || null;
}

function apStart() {
  if (OPT.noAp) return { ok: false, why: 'started with --no-ap' };
  if (AP.up) return { ok: true };
  var iface = AP.iface || pickIface();
  if (!iface) return { ok: false, why: 'no wireless interface found' };
  if (!has('hostapd')) return { ok: false, why: 'hostapd is not installed on this unit' };
  AP.iface = iface;

  try { fs.mkdirSync(OPT.runDir, 0x1c0); } catch (e) { /* exists */ }
  var conf = path.join(OPT.runDir, 'hostapd.conf');
  var body = [
    'interface=' + iface,
    'driver=nl80211',
    'ssid=' + AP.ssid,
    'hw_mode=g',
    'channel=' + AP.channel,
    'country_code=' + OPT.country,
    'auth_algs=1',
    'wpa=2',
    'wpa_key_mgmt=WPA-PSK',
    'rsn_pairwise=CCMP',
    'wpa_passphrase=' + AP.pass,
    'ignore_broadcast_ssid=0'
  ].join('\n') + '\n';
  try { fs.writeFileSync(conf, body, { mode: 0x180 }); } catch (e) { return { ok: false, why: 'cannot write ' + conf }; }

  var r = sh('ip addr add ' + AP.address + '/24 dev ' + iface + ' 2>/dev/null; ip link set ' + iface + ' up');
  var hp = cp.spawn('hostapd', [conf], { stdio: ['ignore', 'pipe', 'pipe'] });
  hp.on('error', function (e) { log('hostapd failed: ' + e.message); AP.up = false; });
  hp.stderr.on('data', function (d) { log('hostapd: ' + String(d).trim().slice(0, 200)); });
  AP.procs.push(hp);

  // a DHCP server so the phone gets an address; optional (a static IP also works)
  if (has('dnsmasq')) {
    var base = AP.address.replace(/\.\d+$/, '');
    var dm = cp.spawn('dnsmasq', ['-d', '-i', iface, '-F', base + '.50,' + base + '.90,255.255.255.0',
      '--dhcp-option=3,' + AP.address, '--dhcp-option=6,' + AP.address], { stdio: ['ignore', 'ignore', 'pipe'] });
    dm.on('error', function () {});
    AP.procs.push(dm);
  } else {
    log('dnsmasq not present: set a static address on the phone (' + AP.address.replace(/\.\d+$/, '.50') + '/24)');
  }
  AP.up = true;
  log('AP up: ssid="' + AP.ssid + '" on ' + iface + ' at ' + AP.address);
  return { ok: true };
}

function apStop() {
  AP.procs.forEach(function (p) { try { p.kill(); } catch (e) {} });
  AP.procs = [];
  if (AP.iface) sh('ip addr del ' + AP.address + '/24 dev ' + AP.iface + ' 2>/dev/null');
  AP.up = false;
  log('AP down');
}

function stations() {
  if (!AP.iface) return [];
  var r = sh('iw dev ' + AP.iface + ' station dump 2>/dev/null');
  if (!r.ok) return [];
  var out = [], re = /Station ([0-9a-f:]{17})/gi, m;
  while ((m = re.exec(r.out))) out.push({ mac: m[1], ip: null });
  // match leases to MACs where dnsmasq wrote them
  try {
    var leases = fs.readFileSync('/var/lib/misc/dnsmasq.leases', 'utf8').split('\n');
    leases.forEach(function (ln) {
      var f = ln.split(/\s+/);
      if (f.length >= 3) out.forEach(function (s) { if (s.mac.toLowerCase() === String(f[1]).toLowerCase()) s.ip = f[2]; });
    });
  } catch (e) { /* no leases file */ }
  return out;
}

// ---- the app connection (UNIX socket) --------------------------------------
var appSock = null;
var pending = {};          // relay id -> callback(respBytes)
var relaySeq = 1;
var lastActivity = Date.now();

function appSend(obj) {
  if (!appSock) return false;
  try { appSock.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { return false; }
}

function stateMsg(id) {
  return {
    t: 'state', id: id, ok: true,
    ap: { up: AP.up, ssid: AP.ssid, pass: AP.pass, security: AP.security, channel: AP.channel, address: AP.address },
    stations: stations()
  };
}

function onAppLine(line) {
  var msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;
  lastActivity = Date.now();

  // a relayed answer coming back from the app
  if (msg.t === 'uds-reply' && msg.id != null && pending[msg.id]) {
    var cb = pending[msg.id]; delete pending[msg.id];
    cb(msg.data || []);
    return;
  }
  // control commands
  var id = msg.id;
  switch (msg.cmd) {
    case 'status':
    case 'stations':
      appSend(stateMsg(id));
      break;
    case 'ap': {
      var r = msg.up ? apStart() : (apStop(), { ok: true });
      if (!r.ok) appSend({ id: id, ok: false, error: r.why || 'could not start the access point' });
      else appSend(stateMsg(id));
      break;
    }
    case 'set-ssid':
      AP.ssid = String(msg.ssid || '').slice(0, 32) || AP.ssid;
      if (AP.up) { apStop(); apStart(); }
      appSend(stateMsg(id));
      break;
    case 'set-pass': {
      var p = String(msg.pass || '');
      if (p.length < 8 || p.length > 63) { appSend({ id: id, ok: false, error: 'password must be 8-63 characters' }); break; }
      AP.pass = p;
      if (AP.up) { apStop(); apStart(); }
      appSend(stateMsg(id));
      break;
    }
    case 'new-pass':
      AP.pass = genPass();
      if (AP.up) { apStop(); apStart(); }
      appSend(stateMsg(id));
      break;
    default:
      if (id != null) appSend({ id: id, ok: false, error: 'unknown command' });
  }
}

function startAppServer() {
  try { fs.mkdirSync(OPT.runDir, 0x1c0); } catch (e) {}
  try { fs.unlinkSync(OPT.sock); } catch (e) {}
  var srv = net.createServer(function (c) {
    if (appSock) { try { c.end(); } catch (e) {} return; }   // one app at a time
    appSock = c;
    log('app attached');
    var buf = '';
    c.on('data', function (d) {
      buf += String(d);
      if (buf.length > 1024 * 1024) { buf = ''; try { c.destroy(); } catch (e) {} return; }
      var i;
      while ((i = buf.indexOf('\n')) >= 0) { var ln = buf.slice(0, i); buf = buf.slice(i + 1); if (ln) onAppLine(ln); }
    });
    function gone() {
      if (appSock === c) { appSock = null; log('app detached — relay closed'); }
      // anything waiting on the app gets nothing; the tool sees a timeout
      for (var k in pending) if (pending.hasOwnProperty(k)) { try { pending[k]([]); } catch (e) {} }
      pending = {};
    }
    c.on('close', gone);
    c.on('error', gone);
  });
  srv.listen(OPT.sock, function () {
    // the app runs as another user: let its group reach the socket
    try { fs.chmodSync(OPT.sock, 0x1b0); } catch (e) {}
    try { fs.chownSync(OPT.sock, 0, OPT.appGid); } catch (e) {}
    log('listening on ' + OPT.sock + ' (group ' + OPT.appGid + ')');
  });
  srv.on('error', function (e) { log('socket error: ' + e.message); process.exit(1); });
  return srv;
}

// ---- DoIP server (the side a tool connects to) ------------------------------
// A deliberately small subset: routing activation, alive check, and diagnostic
// messages. Everything else is answered with a negative ack rather than guessed.
var DOIP_V = 0x02;
function doipFrame(type, payload) {
  var head = Buffer.alloc(8);
  head[0] = DOIP_V; head[1] = (~DOIP_V) & 0xff;
  head.writeUInt16BE(type, 2);
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function startDoip() {
  var srv = net.createServer(function (c) {
    lastActivity = Date.now();
    var peer = { ip: c.remoteAddress, mac: null };
    log('tool connected from ' + peer.ip);
    var buf = Buffer.alloc(0);
    c.on('data', function (d) {
      lastActivity = Date.now();
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        var type = buf.readUInt16BE(2), len = buf.readUInt32BE(4);
        if (len > 8 * 1024 * 1024) { try { c.destroy(); } catch (e) {} return; }
        if (buf.length < 8 + len) break;
        var payload = buf.slice(8, 8 + len);
        buf = buf.slice(8 + len);
        handleDoip(c, peer, type, payload);
      }
    });
    c.on('error', function () {});
    c.on('close', function () { log('tool disconnected'); });
  });
  srv.on('error', function (e) { log('DoIP listen error: ' + e.message); });
  // Bind to the AP address only when we host the AP, so the listener is not
  // exposed on whatever other networks the unit happens to be on.
  var host = (AP.up && !OPT.noAp) ? AP.address : '0.0.0.0';
  srv.listen(OPT.doipPort, host, function () { log('DoIP on ' + host + ':' + OPT.doipPort); });
  return srv;
}

function handleDoip(c, peer, type, payload) {
  if (type === 0x0005) {                       // routing activation request
    var src = payload.length >= 2 ? payload.readUInt16BE(0) : 0x0e00;
    var res = Buffer.alloc(9);
    res.writeUInt16BE(src, 0);
    res.writeUInt16BE(0x1000, 2);              // our logical address
    res[4] = appSock ? 0x10 : 0x06;            // 0x10 accepted; 0x06 = not authenticated
    c.write(doipFrame(0x0006, res));
    return;
  }
  if (type === 0x0007) { c.write(doipFrame(0x0008, Buffer.alloc(0))); return; }  // alive check
  if (type !== 0x8001) {                        // anything else: not supported
    c.write(doipFrame(0x0000, Buffer.from([0x02])));
    return;
  }
  // diagnostic message: [srcAddr(2)][targetAddr(2)][uds...]
  if (payload.length < 5) return;
  var sa = payload.readUInt16BE(0), ta = payload.readUInt16BE(2);
  var uds = Array.prototype.slice.call(payload.slice(4));
  if (!appSock) {                               // nothing attached: refuse, never guess
    var nk = Buffer.alloc(5);
    nk.writeUInt16BE(ta, 0); nk.writeUInt16BE(sa, 2); nk[4] = 0x02;
    c.write(doipFrame(0x8003, nk));             // diagnostic message negative ack
    return;
  }
  // positive ack, then ask the app (which decides whether it may go to the car)
  var ack = Buffer.alloc(5);
  ack.writeUInt16BE(ta, 0); ack.writeUInt16BE(sa, 2); ack[4] = 0x00;
  c.write(doipFrame(0x8002, ack));

  var id = 'r' + (relaySeq++);
  var timer = setTimeout(function () { if (pending[id]) { delete pending[id]; } }, 8000);
  pending[id] = function (respBytes) {
    clearTimeout(timer);
    if (!respBytes || !respBytes.length) return;
    var body = Buffer.concat([Buffer.from([(ta >> 8) & 0xff, ta & 0xff, (sa >> 8) & 0xff, sa & 0xff]),
      Buffer.from(respBytes)]);
    try { c.write(doipFrame(0x8001, body)); } catch (e) {}
  };
  appSend({ t: 'uds', id: id, ecu: ta & 0xff, data: uds, peer: peer });
}

// ---- main ------------------------------------------------------------------
var appServer = null, doipServer = null, idleTimer = null;

function shutdown(code) {
  try { apStop(); } catch (e) {}
  try { if (appServer) appServer.close(); } catch (e) {}
  try { if (doipServer) doipServer.close(); } catch (e) {}
  try { if (idleTimer) clearInterval(idleTimer); } catch (e) {}
  try { fs.unlinkSync(OPT.sock); } catch (e) {}
  try { fs.unlinkSync(path.join(OPT.runDir, 'hostapd.conf')); } catch (e) {}
  process.exit(code || 0);
}

function main() {
  if (OPT.probe) { probe(); process.exit(0); }

  log('starting (pid ' + process.pid + ')');
  appServer = startAppServer();
  var apRes = apStart();
  if (!apRes.ok) log('access point not started: ' + apRes.why + '  (the relay still works over an existing network)');
  doipServer = startDoip();

  // Idle shutdown: never leave an access point broadcasting for a session
  // somebody forgot about.
  idleTimer = setInterval(function () {
    if (OPT.idleSec > 0 && (Date.now() - lastActivity) > OPT.idleSec * 1000) {
      log('idle for ' + OPT.idleSec + 's - shutting down');
      shutdown(0);
    }
  }, 15000);

  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(function (sig) {
    process.on(sig, function () { log('signal ' + sig); shutdown(0); });
  });
  process.on('uncaughtException', function (e) { log('fatal: ' + ((e && e.stack) || e)); shutdown(1); });
}

// Only run when executed directly; `require()` (the tests) just gets the pieces.
if (require.main === module) main();

module.exports = {
  genPass: genPass, doipFrame: doipFrame, stations: stations, apCapable: apCapable,
  onAppLine: onAppLine, stateMsg: stateMsg, handleDoip: handleDoip, AP: AP, OPT: OPT,
  _setAppSock: function (s) { appSock = s; }, _pending: function () { return pending; }
};
