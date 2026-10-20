'use strict';
// OS-specific pieces behind one interface. Only Windows is implemented; on other platforms every
// function throws a clear "not supported yet" error when it is used.
const win32 = require('./win32');

const current = process.platform;

function unsupported() {
  throw new Error(`This bridge only supports Windows so far; "${current}" is not supported yet.`);
}

module.exports = current === 'win32'
  ? win32
  : Object.fromEntries(Object.keys(win32).map(name => [name, unsupported]));
