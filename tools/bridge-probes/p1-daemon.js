'use strict';
// p1-daemon.js — settle probe P1: can the BeeM-Flash app (sandbox uid) connect to
// a UNIX socket owned by a root daemon? Run as ROOT on the head unit:
//     node p1-daemon.js
// It creates /run/beem-probe/p.sock (also tries /dev/shm/beem-probe/p.sock),
// chowns it to the app group (tm_oap_app, gid 12202) mode 0660, and echoes.
// Then point the app's P1 probe (config.bridgeProbe) at it, or test with:
//     nc -U /run/beem-probe/p.sock
// If the app connects and gets "pong", the app<->daemon channel is PROVEN.
var net = require('net'), fs = require('fs'), path = require('path');
var APP_GID = 12202; // tm_oap_app — every OAP app has it
[ '/run/beem-probe', '/dev/shm/beem-probe' ].forEach(function (dir) {
  try {
    try { fs.mkdirSync(dir); } catch (e) {}
    var p = path.join(dir, 'p.sock');
    try { fs.unlinkSync(p); } catch (e) {}
    var srv = net.createServer(function (s) {
      s.on('data', function (d) { process.stdout.write('[app->daemon] ' + d); s.write('pong\n'); });
    });
    srv.listen(p, function () {
      try { fs.chmodSync(p, 0o660); } catch (e) {}
      try { fs.chownSync(p, 0, APP_GID); } catch (e) {}
      console.log('listening on ' + p + ' (group ' + APP_GID + ', mode 0660)');
    });
    srv.on('error', function (e) { console.log('could not listen on ' + p + ': ' + e.message); });
  } catch (e) { console.log(dir + ': ' + e.message); }
});
console.log('Now run the app P1 probe (set config.bridgeProbe=true) or: nc -U /run/beem-probe/p.sock');
