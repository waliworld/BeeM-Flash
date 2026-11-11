'use strict';
// Entry for the browser preview bundle. Exposes the real App plus a couple of
// modules the page needs to build demo state.
var main = require('../../apps/wali_datalog/main.js');
var Channels = require('../../apps/wali_datalog/src/channels');
module.exports = { App: main.App, Channels: Channels };
