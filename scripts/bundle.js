'use strict';
//
// bundle.js — minimal CommonJS bundler (no dependencies).
//
// Inlines the app's local modules into one browser script so the real app code
// runs unchanged in a browser for the visual preview. Node builtins (fs/path)
// are stubbed because the preview injects an in-memory storage and never calls
// the filesystem paths.
//
var fs = require('fs');
var path = require('path');

function resolve(p) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p + '.js')) return p + '.js';
  return p;
}

function bundle(entry) {
  var modules = {};
  var order = [];

  function load(abs) {
    abs = resolve(abs);
    if (modules.hasOwnProperty(abs)) return abs;
    modules[abs] = ''; // reserve (cycle guard)
    var code = fs.readFileSync(abs, 'utf8');
    code = code.replace(/require\(\s*(['"])(\.[^'"]+)\1\s*\)/g, function (m, q, rel) {
      var childAbs = resolve(path.join(path.dirname(abs), rel));
      load(childAbs);
      return '__require(' + JSON.stringify(childAbs) + ')';
    });
    code = code.replace(/require\(\s*(['"])(fs|path|crypto)\1\s*\)/g, function () { return '__builtin()'; });
    modules[abs] = code;
    order.push(abs);
    return abs;
  }

  var entryAbs = load(path.resolve(entry));
  var out = '(function(){\n';
  out += 'var __cache={}, __defs={};\n';
  out += 'function __builtin(){return {};}\n';
  order.forEach(function (abs) {
    out += '__defs[' + JSON.stringify(abs) + ']=function(module,exports,__require){\n' + modules[abs] + '\n};\n';
  });
  out += 'function __require(id){if(__cache[id])return __cache[id].exports;var m={exports:{}};__cache[id]=m;__defs[id](m,m.exports,__require);return m.exports;}\n';
  out += 'window.__ENTRY=__require(' + JSON.stringify(entryAbs) + ');\n';
  out += '})();';
  return out;
}

if (require.main === module) {
  var entry = process.argv[2];
  var outFile = process.argv[3];
  var code = bundle(entry);
  if (outFile) { fs.writeFileSync(outFile, code); console.log('wrote ' + outFile + ' (' + code.length + ' bytes)'); }
  else process.stdout.write(code);
}

module.exports = { bundle: bundle };
