'use strict';
//
// hsfzprobe.js — can this head unit reach the car's gateway over IP?
//
// BMW's diagnostics-over-IP comes in two flavours:
//   * HSFZ  (Hochgeschwindigkeits-Fahrzeug-Zugang), BMW's own: TCP 6801 for
//     diagnostic/flashing traffic, UDP 6811 for vehicle identification.
//   * DoIP  (ISO 13400): TCP/UDP 13400.
//
// The head unit reports addresses in 160.48.x.x — BMW's diagnostic Ethernet
// range — so it may already be ON the network an ENET adapter would bridge to.
// If so, the app could proxy a tool's TCP stream straight to the gateway with
// NO protocol translation, which is what real ENET tools expect.
//
// This module only ASKS. It sends the standard identification request and tries
// to open a connection; it writes nothing to any ECU and changes nothing. The
// point is to replace an assumption with an answer before building on it.
//
var HSFZ_TCP = 6801, HSFZ_UDP = 6811, DOIP = 13400;

// HSFZ framing: [4-byte payload length][2-byte control word][payload]
//   control 0x0001 = diagnostic message, 0x0002 = vehicle identification
function hsfzFrame(control, payload) {
  payload = payload || [];
  var out = [
    (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff,
    (payload.length >>> 8) & 0xff, payload.length & 0xff,
    (control >> 8) & 0xff, control & 0xff
  ];
  return Buffer.from(out.concat(payload));
}

function ipCandidates(netMod, osMod) {
  var os = osMod || require('os');
  var out = [], seen = {};
  var ifs = os.networkInterfaces() || {};
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (!a || (a.family !== 'IPv4' && a.family !== 4) || a.internal) return;
      var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a.address);
      if (!m) return;
      // the subnet broadcast, where a gateway announcement would arrive
      var bcast = m[1] + '.' + m[2] + '.' + m[3] + '.255';
      if (!seen[bcast]) { seen[bcast] = 1; out.push({ kind: 'broadcast', iface: name, ip: bcast }); }
    });
  });
  if (!seen['255.255.255.255']) out.push({ kind: 'broadcast', iface: '*', ip: '255.255.255.255' });
  return out;
}

// Ask for a vehicle identification over UDP; resolve with whatever answered.
function identify(opts) {
  opts = opts || {};
  var dgram;
  try { dgram = opts.dgram || require('dgram'); } catch (e) {
    return Promise.resolve({ ok: false, error: 'no UDP support in this sandbox', replies: [] });
  }
  var port = opts.port || HSFZ_UDP;
  var waitMs = opts.waitMs || 1200;
  var targets = opts.targets || ipCandidates();
  return new Promise(function (resolve) {
    var replies = [], sock, done = false;
    function finish(err) {
      if (done) return; done = true;
      try { sock && sock.close(); } catch (e) {}
      resolve({ ok: !err && replies.length > 0, error: err || null, replies: replies, asked: targets.map(function (t) { return t.ip; }) });
    }
    try { sock = dgram.createSocket('udp4'); } catch (e) { return finish((e && (e.code || e.message)) || String(e)); }
    sock.on('error', function (e) { finish((e && (e.code || e.message)) || String(e)); });
    sock.on('message', function (msg, rinfo) {
      replies.push({ from: rinfo.address, port: rinfo.port, bytes: msg.length, hex: msg.toString('hex').slice(0, 96) });
    });
    sock.bind(function () {
      try { sock.setBroadcast(true); } catch (e) { /* may be refused; unicast still works */ }
      var pkt = hsfzFrame(0x0002, []);
      targets.forEach(function (t) { try { sock.send(pkt, 0, pkt.length, port, t.ip); } catch (e) {} });
      setTimeout(function () { finish(null); }, waitMs);
    });
  });
}

// Can we open a TCP connection to a diagnostic port? (connect only, no traffic)
function reach(host, port, opts) {
  opts = opts || {};
  var net;
  try { net = opts.net || require('net'); } catch (e) {
    return Promise.resolve({ host: host, port: port, ok: false, error: 'no TCP support' });
  }
  var ms = opts.timeoutMs || 900;
  return new Promise(function (resolve) {
    var c, done = false;
    function finish(err) {
      if (done) return; done = true;
      try { c && c.destroy(); } catch (e) {}
      resolve({ host: host, port: port, ok: !err, error: err || null });
    }
    try { c = net.connect(port, host); } catch (e) { return finish((e && (e.code || e.message)) || String(e)); }
    c.setTimeout && c.setTimeout(ms, function () { finish('timeout'); });
    c.on('connect', function () { finish(null); });
    c.on('error', function (e) { finish((e && (e.code || e.message)) || String(e)); });
    setTimeout(function () { finish('timeout'); }, ms + 150);
  });
}

// run() -> { identify, reachable } — the whole question in one call.
// Candidate gateway addresses on each subnet the unit is on. The gateway often
// does NOT answer a discovery broadcast but DOES accept a directed connection
// (this is how ISTA/E-Sys reach it). On BMW's internal diagnostic Ethernet the
// gateway has historically sat at .99 of a 160.48.x block; we also try the
// conventional .1 and the unit's own-address neighbours. Read-only: a TCP
// connect, nothing written to the car.
function candidateHosts(opts) {
  var osMod = opts.osMod;
  var os = osMod || (function () { try { return require('os'); } catch (e) { return null; } })();
  if (!os) return [];
  var out = {}, ifs = os.networkInterfaces() || {};
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (!a || (a.family !== 'IPv4' && a.family !== 4) || a.internal) return;
      var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a.address);
      if (!m) return;
      var base = m[1] + '.' + m[2] + '.' + m[3] + '.', self = parseInt(m[4], 10);
      [1, 99, 100, self - 1, self + 1].forEach(function (h) {
        if (h >= 1 && h <= 254 && h !== self) out[base + h] = 1;
      });
    });
  });
  return Object.keys(out);
}

function run(opts) {
  opts = opts || {};
  return identify(opts).then(function (id) {
    // Probe whatever announced itself, any host the caller named, AND a bounded
    // set of directed gateway candidates on the unit's own subnets.
    var hosts = {}, directed = {};
    (id.replies || []).forEach(function (r) { hosts[r.from] = 1; });
    (opts.hosts || []).forEach(function (h) { hosts[h] = 1; });
    if (opts.directed !== false) candidateHosts(opts).forEach(function (h) { if (!hosts[h]) directed[h] = 1; });
    var list = Object.keys(hosts), dlist = Object.keys(directed);
    var jobs = [], labels = [];
    list.forEach(function (h) {
      jobs.push(reach(h, HSFZ_TCP, opts)); labels.push({ host: h, kind: 'announced' });
      jobs.push(reach(h, DOIP, opts)); labels.push({ host: h, kind: 'announced' });
    });
    dlist.forEach(function (h) {
      jobs.push(reach(h, HSFZ_TCP, opts)); labels.push({ host: h, kind: 'directed' });
      jobs.push(reach(h, DOIP, opts)); labels.push({ host: h, kind: 'directed' });
    });
    if (!jobs.length) return { identify: id, reachable: [], directed: dlist };
    return Promise.all(jobs).then(function (rs) {
      for (var i = 0; i < rs.length; i++) if (labels[i]) rs[i].kind = labels[i].kind;
      return { identify: id, reachable: rs, directed: dlist };
    });
  });
}

module.exports = {
  run: run, identify: identify, reach: reach, candidateHosts: candidateHosts, hsfzFrame: hsfzFrame, ipCandidates: ipCandidates,
  HSFZ_TCP: HSFZ_TCP, HSFZ_UDP: HSFZ_UDP, DOIP: DOIP
};
