#!/usr/bin/env node
// Run the WebAssembly `lean` under Node, the same binary the browser uses.
// Usage: node tools/lean-node.cjs <lean.js> <lib-dir> <work-dir> <file.lean>
//   <lib-dir> is mounted at /lib/lean (LEAN_PATH), <work-dir> at /work (cwd).
// Set OPENLOG=<path> to record every library file Lean touches (used to find
// the import closure). Modeled on scripts/lean-wasm-node.cjs from
// cauli/lean4-wasm-in-browser (Apache-2.0).
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const [leanJsArg, libArg, workArg, file] = process.argv.slice(2);
if (!file) {
  console.error('usage: lean-node.cjs <lean.js> <lib-dir> <work-dir> <file.lean>');
  process.exit(2);
}
const leanJs = path.resolve(leanJsArg);
const libLean = path.resolve(libArg);
const work = path.resolve(workArg);

if (process.env.OPENLOG) {
  const seen = new Set();
  for (const k of ['openSync', 'statSync', 'lstatSync', 'existsSync']) {
    const orig = fs[k];
    fs[k] = function (p, ...rest) {
      if (typeof p === 'string' && p.startsWith(libLean + '/') && !seen.has(p)) {
        seen.add(p);
        fs.appendFileSync(process.env.OPENLOG, p.slice(libLean.length + 1) + '\n');
      }
      return orig.call(this, p, ...rest);
    };
  }
}

process.chdir('/');               // the glue chdirs MEMFS to process.cwd()
process.argv[1] = '/bin/lean';    // so Lean derives /lib/lean as its sysroot

globalThis.Module = {
  arguments: [file],
  locateFile: (f) => path.join(path.dirname(leanJs), f),
  mainScriptUrlOrBlob: leanJs,
  preRun: [function () {
    const FS = Module.FS;
    for (const d of ['/lib', '/lib/lean', '/work', '/bin']) { try { FS.mkdir(d); } catch (e) {} }
    FS.mount(FS.filesystems.NODEFS, { root: libLean }, '/lib/lean');
    FS.mount(FS.filesystems.NODEFS, { root: work }, '/work');
    Module.ENV.LEAN_PATH = '/lib/lean';
    FS.chdir('/work');
  }],
  onExit: (code) => { process.exitCode = code; },
  onAbort: (what) => { console.error('ABORT:', what); process.exit(3); },
};
globalThis.require = require;
globalThis.__filename = '/bin/lean.js';
globalThis.__dirname = '/bin';
vm.runInThisContext(fs.readFileSync(leanJs, 'utf8'), { filename: leanJs });
