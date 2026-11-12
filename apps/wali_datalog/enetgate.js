'use strict';
//
// enetgate.js — the safety gate in front of the vehicle (ENET/DoIP) connection.
//
// This does not make the connection itself read-only — src/doip.js already
// contains no write/flash/security-access code (see NOTICE.md) — it controls
// whether the app is even PERMITTED to open a network connection to the car's
// diagnostic bus at all.
//
// Default state, every time the app starts, is fully disconnected: no socket
// is opened and no packet is sent. To connect, the user must, in order:
//   1. acknowledge() the safety disclosure on the Connect screen, and
//   2. setEnabled(true) to allow a connection this session.
// Acknowledgment is remembered (so the disclosure need not be re-read every
// launch), but `enabled` is NEVER persisted as true and always starts false:
// every session requires the user to press Enable again, deliberately, before
// any vehicle network traffic is sent. Disabling (or losing acknowledgment)
// immediately forgets any discovered vehicle.
//
var doip = require('./doip');

function EnetGate(opts) {
  opts = opts || {};
  this.storage = opts.storage || null;
  this.acknowledged = false;
  this.enabled = false;   // in-memory only; never persisted as true
  this.vehicle = null;    // in-memory only: { vin, host, logicalAddress }
  this.scanning = false;
  this._load();
}

EnetGate.prototype._load = function () {
  try {
    if (this.storage && this.storage.read) {
      var txt = this.storage.read('enet.json');
      if (txt) this.acknowledged = !!JSON.parse(txt).acknowledged;
    }
  } catch (e) {}
};

EnetGate.prototype._save = function () {
  try {
    if (this.storage && this.storage.open) {
      var h = this.storage.open('enet.json');
      this.storage.append(h, JSON.stringify({ acknowledged: this.acknowledged }));
      this.storage.close(h);
    }
  } catch (e) {}
};

// Record that the user has read and accepted the safety disclosure.
EnetGate.prototype.acknowledge = function () {
  this.acknowledged = true;
  this._save();
};

// Withdraw acknowledgment. Also disables and forgets any vehicle, since
// enabling requires acknowledgment.
EnetGate.prototype.revoke = function () {
  this.acknowledged = false;
  this.enabled = false;
  this.vehicle = null;
  this._save();
};

// Permit (or forbid) a connection this session. Refuses to enable without a
// prior acknowledgment. Returns { ok, reason }.
EnetGate.prototype.setEnabled = function (on) {
  if (on) {
    if (!this.acknowledged) return { ok: false, reason: 'Acknowledge the safety warning first.' };
    this.enabled = true;
  } else {
    this.enabled = false;
    this.vehicle = null;
  }
  return { ok: true };
};

EnetGate.prototype.setVehicle = function (v) { this.vehicle = v || null; };

// Broadcast a Vehicle Identification Request and collect responses. Refuses
// (resolves []) unless enabled, so discovery can never run while disconnected.
EnetGate.prototype.scan = function (socketFactory, opts) {
  var self = this;
  if (!this.enabled) return Promise.resolve([]);
  var socket = null;
  try { socket = socketFactory && socketFactory(); } catch (e) {}
  if (!socket) return Promise.resolve([]);
  this.scanning = true;
  return doip.discoverVehicles(socket, opts).then(
    function (found) { self.scanning = false; return found; },
    function () { self.scanning = false; return []; }
  );
};

EnetGate.prototype.status = function () {
  return {
    acknowledged: this.acknowledged,
    enabled: this.enabled,
    scanning: this.scanning,
    vehicle: this.vehicle,
    connected: this.enabled && !!this.vehicle
  };
};

module.exports = EnetGate;
