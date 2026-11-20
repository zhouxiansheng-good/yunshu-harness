'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { Script } = require('node:vm');

// Harness evaluates each web entry as a classic script in its module loader.
// Node's normal module parser accepts top-level imports that the desktop rejects.
const [entry, packageName] = process.argv.slice(2);
const registrations = new Set();
const loader = {
  load({ id, factory }) {
    assert.equal(typeof factory, 'function', `Invalid factory for ${id}`);
    assert.ok(!registrations.has(id), `Duplicate client registration for ${id}`);
    registrations.add(id);
  },
};
const script = new Script(readFileSync(entry, 'utf8'), { filename: entry });
const window = Object.assign(new EventTarget(), { __ModuleLoader__: loader });
script.runInNewContext({ window, Event, console, setTimeout, clearTimeout, setInterval, clearInterval }, { timeout: 3000 });
assert.ok(registrations.has(packageName), `Missing client registration for ${packageName}`);
