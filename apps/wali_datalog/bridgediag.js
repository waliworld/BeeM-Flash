'use strict';
//
// bridgediag.js — in-app diagnostics for the wireless-bridge feasibility probes,
// runnable from SETUP -> DIAGNOSTICS on the head unit (no SSH needed).
//
// It runs ONLY what the app sandbox can actually do, and is honest about the rest:
//   * NET  — the head unit's own IPv4 interfaces (os.networkInterfaces): shows the
//            wlan0 address a phone would target. No socket needed.
//   * P1   — can the app connect() to a root daemon's UNIX socket? (the foundation
//            of the bridge architecture). Reports per-path: ok / EACCES / ENOENT / timeout.
//   * P6   — one live UDS read (22 F1 90 VIN) over the TASU link: does the car
//            answer US at all? reply / NRC / no-reply.
// It CANNOT do P3 (bind an inbound listener for the phone) — no sandbox can; that
// needs the root daemon. The screen says so rather than implying otherwise.
//
var CANDIDATE_SOCKETS = ['/run/beem-probe/p.sock', '/dev/shm/beem-probe/p.sock', '/run/beem-bridge/bridge.sock'];

function netInfo() {
  var out = [];
  try {
    var os = require('os');
    var ifs = os.networkInterfaces() || {};
    Object.keys(ifs).forEach(function (name) {
      (ifs[name] || []).forEach(function (a) {
        if (a && (a.family === 'IPv4' || a.family === 4)) {
          out.push({ iface: name, ip: a.address, mac: a.mac || '', internal: !!a.internal });
        }
      });
    });
  } catch (e) { out.push({ iface: '(error)', ip: String(e && e.message || e), mac: '', internal: false }); }
  return out;
}

function probeSocket(path, timeoutMs, netMod) {
  return new Promise(function (resolve) {
    var net = netMod; try { if (!net) net = require('net'); } catch (e) { resolve({ path: path, status: 'no-net' }); return; }
    var done = false, c;
    function finish(status, detail) { if (done) return; done = true; try { c && c.destroy(); } catch (e) {} resolve({ path: path, status: status, detail: detail || '' }); }
    try { c = net.connect(path); } catch (e) { finish('error', String(e && e.message)); return; }
    try {
      c.on('connect', function () { try { c.write('ping\n'); } catch (e) {} });
      c.on('data', function (d) { finish('ok', String(d).trim()); });
      c.on('error', function (e) { finish((e && e.code) || 'error', String(e && e.message)); });
    } catch (e) { finish('error', String(e && e.message)); return; }
    setTimeout(function () { finish('timeout', ''); }, timeoutMs || 1200);
  });
}

function probeSockets(paths, netMod) {
  paths = paths || CANDIDATE_SOCKETS;
  var out = [], i = 0;
  function next() {
    if (i >= paths.length) return Promise.resolve(out);
    return probeSocket(paths[i++], 1200, netMod).then(function (r) { out.push(r); return next(); });
  }
  return next();
}

// send(bytes) -> Promise<udsBytes> (the app's vehiclelink). Reads the VIN from the DME.
function probeTasu(send) {
  if (typeof send !== 'function') return Promise.resolve({ status: 'no-link', note: 'no diagnostic link in this build' });
  var p;
  try { p = send([0x22, 0xF1, 0x90]); } catch (e) { return Promise.resolve({ status: 'no-reply', note: String(e && e.message || e) }); }
  return Promise.resolve(p).then(function (uds) {
    if (!uds || !uds.length) return { status: 'empty' };
    if (uds[0] === 0x62) {
      var vin = '';
      for (var i = 3; i < uds.length; i++) { var ch = uds[i]; vin += (ch >= 32 && ch < 127) ? String.fromCharCode(ch) : '.'; }
      return { status: 'ok', vin: vin, bytes: uds.length };
    }
    if (uds[0] === 0x7f) return { status: 'nrc', nrc: uds[2] };
    return { status: 'other', first: uds[0] };
  }, function (e) { return { status: 'no-reply', note: String(e && e.message || e) }; });
}

function run(opts) {
  opts = opts || {};
  return probeSockets(opts.socketPaths, opts.netMod).then(function (sockets) {
    return probeTasu(opts.send).then(function (tasu) {
      // P7: is the car's own diagnostic gateway reachable over IP from here?
      // The head unit reports 160.48.x.x addresses - BMW's diagnostic Ethernet
      // range - so it may already be on the network an ENET adapter bridges to.
      // If the gateway answers, a tool's traffic could be proxied straight
      // through with no protocol translation at all.
      var hsfz;
      try { hsfz = require('./hsfzprobe'); } catch (e) { hsfz = null; }
      var gw = hsfz ? hsfz.run({ waitMs: (opts.hsfzWaitMs || 1200), hosts: opts.hsfzHosts })
        .catch(function (e) { return { error: (e && e.message) || String(e) }; })
        : Promise.resolve({ error: 'probe unavailable' });
      return gw.then(function (gateway) {
        return probePrivilegedBind(opts).then(function (pb) {
          return { net: netInfo(), sockets: sockets, tasu: tasu, gateway: gateway,
            priv: privInfo(), privBind: pb, at: (opts.now ? opts.now() : Date.now()) };
        });
      });
    });
  });
}

// P8 - what privileges does this app process actually have?
//
// A rooted head unit is NOT the same thing as an app running as root: the
// platform's service manager normally starts apps under a constrained account.
// The difference decides what is even possible here, so ask the OS rather than
// assume either way. Running as root would unlock binding privileged ports
// (<1024) and, far more importantly, bringing up a Wi-Fi access point from
// inside the app instead of needing a separate helper.
function privInfo() {
  var out = { uid: null, gid: null, euid: null, root: false, note: null };
  try {
    if (process.getuid) out.uid = process.getuid();
    if (process.getgid) out.gid = process.getgid();
    if (process.geteuid) out.euid = process.geteuid();
    out.root = (out.euid === 0) || (out.uid === 0);
  } catch (e) { out.note = (e && e.message) || String(e); }
  return out;
}

// Can we actually bind a privileged port? Capability can be granted without
// full root (CAP_NET_BIND_SERVICE), so test it instead of inferring from uid.
// Uses 1023, which is privileged but not a service anyone runs, so nothing is
// disturbed; the listener is closed immediately.
function probePrivilegedBind(opts) {
  opts = opts || {};
  var net;
  try { net = opts.netMod || require('net'); } catch (e) {
    return Promise.resolve({ ok: false, port: 1023, error: 'no TCP support' });
  }
  var port = opts.port || 1023;
  return new Promise(function (resolve) {
    var srv, done = false;
    function finish(err) {
      if (done) return; done = true;
      try { srv && srv.close(); } catch (e) {}
      resolve({ ok: !err, port: port, error: err || null });
    }
    try { srv = net.createServer(function () {}); } catch (e) { return finish((e && (e.code || e.message)) || String(e)); }
    srv.on('error', function (e) { finish((e && e.code) ? e.code : ((e && e.message) || String(e))); });
    try { srv.listen(port, '127.0.0.1', function () { finish(null); }); }
    catch (e) { finish((e && (e.code || e.message)) || String(e)); }
    setTimeout(function () { finish('timeout'); }, 800);
  });
}

module.exports = { run: run, netInfo: netInfo, privInfo: privInfo, probePrivilegedBind: probePrivilegedBind, probeSockets: probeSockets, probeSocket: probeSocket, probeTasu: probeTasu, CANDIDATE_SOCKETS: CANDIDATE_SOCKETS };
