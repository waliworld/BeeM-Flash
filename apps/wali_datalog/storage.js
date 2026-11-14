'use strict';
//
// storage.js — pluggable log storage.
//
// fsStorage(baseDir): writes logs under the app's persistent data dir
//   (ctx.dataDir on the head unit). export() copies a finished log to a mount
//   point such as a USB stick.
// memStorage(): in-memory, for tests and headless runs.
//
var fs = require('fs');
var path = require('path');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function fsStorage(baseDir) {
  ensureDir(baseDir);
  return {
    kind: 'fs',
    baseDir: baseDir,
    open: function (name) {
      var p = path.join(baseDir, name);
      return { name: name, path: p, fd: fs.openSync(p, 'w') };
    },
    append: function (h, text) { fs.writeSync(h.fd, text); },
    close: function (h) { fs.closeSync(h.fd); },
    size: function (h) { try { return fs.statSync(h.path).size; } catch (e) { return 0; } },
    list: function () {
      try { return fs.readdirSync(baseDir); } catch (e) { return []; }
    },
    // Names inside one sub-folder (e.g. 'flash'), returned as 'flash/<name>'.
    // list() only sees the top level, so the Flash tab could never see the
    // tunes an owner placed under flash/.
    listDir: function (sub) {
      try {
        return fs.readdirSync(path.join(baseDir, sub)).map(function (n) { return sub.replace(/\/+$/, '') + '/' + n; });
      } catch (e) { return []; }
    },
    read: function (name) { return fs.readFileSync(path.join(baseDir, name), 'utf8'); },
    // Byte count without reading the file. The LOG list only needs a size label;
    // reading every CSV in full to measure it made each frame cost more the more
    // the owner had recorded.
    statSize: function (name) { try { return fs.statSync(path.join(baseDir, name)).size; } catch (e) { return 0; } },
    remove: function (name) { fs.unlinkSync(path.join(baseDir, name)); },
    // destDir is a mounted writable path (e.g. a USB stick). Throws if absent.
    export: function (name, destDir) {
      if (!destDir) throw new Error('No destination (insert USB media)');
      if (!fs.existsSync(destDir)) throw new Error('Destination not available: ' + destDir);
      var src = path.join(baseDir, name);
      var dst = path.join(destDir, name);
      fs.copyFileSync(src, dst);
      return dst;
    }
  };
}

function memStorage() {
  var files = {};
  var open = {};
  return {
    kind: 'mem',
    _files: files,
    open: function (name) { files[name] = ''; open[name] = true; return { name: name }; },
    append: function (h, text) { files[h.name] = (files[h.name] || '') + text; },
    close: function (h) { open[h.name] = false; },
    size: function (h) { return Buffer.byteLength(files[h.name] || ''); },
    list: function () { return Object.keys(files); },
    listDir: function (sub) {
      var pre = sub.replace(/\/+$/, '') + '/';
      return Object.keys(files).filter(function (n) { return n.indexOf(pre) === 0 && n.indexOf('/', pre.length) < 0; });
    },
    read: function (name) { return files[name] || ''; },
    remove: function (name) { delete files[name]; },
    export: function (name, destDir) {
      if (!destDir) throw new Error('No destination (insert USB media)');
      return destDir + '/' + name;
    }
  };
}

module.exports = { fsStorage: fsStorage, memStorage: memStorage, ensureDir: ensureDir };
