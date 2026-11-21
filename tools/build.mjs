#!/usr/bin/env node
// Build the static site into <out>:
//   1. run the WebAssembly lean on TinyLLM.lean with the full Init library and
//      record which library files it touches (the import closure),
//   2. run it again with ONLY those files present; fail the build on any error,
//   3. pack that closure into lib.pack.gz, gzip lean.wasm, copy the site.
// Usage: node tools/build.mjs <runtime-dir> <out-dir>
//   <runtime-dir> = the extracted runtime fixture (bin/, runtime/, lib/lean/).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [rtArg, outArg] = process.argv.slice(2);
if (!rtArg || !outArg) { console.error('usage: build.mjs <runtime-dir> <out-dir>'); process.exit(2); }
const rt = path.resolve(rtArg), out = path.resolve(outArg);
const runtimeInfo = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'));
const SOURCE = 'TinyLLM.lean';

const DEBUG = /^\s*\[(WASM DEBUG|DEBUG|IFRAME|PROFILE|PWORKER|COMPILE)/;
function cleanOutput(text) {
  const keep = []; let echo = false;
  for (const line of text.split('\n')) {
    if (DEBUG.test(line)) { echo = /Input file content/.test(line); continue; }
    if (echo) continue;              // the runtime echoes the first 200 chars of the input
    if (/^\s*-\s+\/lib\/lean\//.test(line)) continue;
    keep.push(line);
  }
  return keep.join('\n').trim();
}

function runLean(libDir, openLog) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyllm-work-'));
  fs.copyFileSync(path.join(root, SOURCE), path.join(work, SOURCE));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'tools/lean-node.cjs'), path.join(rt, 'bin/lean.js'), libDir, work, `/work/${SOURCE}`], {
    encoding: 'utf8', maxBuffer: 64 << 20, cwd: os.tmpdir(),
    env: { ...process.env, ...(openLog ? { OPENLOG: openLog } : {}) },
  });
  const raw = (r.stdout || '') + (r.stderr || '');
  return { status: r.status, raw, output: cleanOutput(raw), seconds: (Date.now() - t0) / 1000,
           hasErrors: !/hasErrors = false/.test(raw) || /(^|\n)[^\n]*:\d+:\d+: error/.test(raw) };
}

// ---- 1. find the closure ----
const fullLib = path.join(rt, 'lib/lean');
const openLog = path.join(os.tmpdir(), `tinyllm-opens-${process.pid}.txt`);
fs.rmSync(openLog, { force: true });
const pass1 = runLean(fullLib, openLog);
if (pass1.status !== 0 || pass1.hasErrors) { console.error(pass1.raw); throw new Error('lean failed on the full library'); }
const touched = [...new Set(fs.readFileSync(openLog, 'utf8').split('\n').filter(Boolean))];
const files = touched.filter((p) => { const f = path.join(fullLib, p); return fs.existsSync(f) && fs.statSync(f).isFile(); }).sort();
const modules = files.filter((p) => p.endsWith('.olean')).length;
const allOleans = fs.readdirSync(fullLib, { recursive: true }).filter((p) => String(p).endsWith('.olean')).length;
console.log(`closure: ${modules} of ${allOleans} modules, ${files.length} files (pass 1 took ${pass1.seconds}s)`);

// ---- 2. re-check with only the closure present ----
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyllm-lib-'));
for (const p of files) {
  fs.mkdirSync(path.dirname(path.join(staged, p)), { recursive: true });
  fs.copyFileSync(path.join(fullLib, p), path.join(staged, p));
}
const pass2 = runLean(staged, null);
if (pass2.status !== 0 || pass2.hasErrors) { console.error(pass2.raw); throw new Error('lean failed on the trimmed library'); }
console.log(`trimmed library: Lean accepts ${SOURCE} (${pass2.seconds}s)\n${pass2.output}`);

// ---- 3. write the site ----
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'rt/slim'), { recursive: true });

// lib.pack: "TLPK" | u32 header length | JSON [[path, bytes], ...] | file bytes
const header = Buffer.from(JSON.stringify(files.map((p) => [p, fs.statSync(path.join(fullLib, p)).size])));
const len = Buffer.alloc(4); len.writeUInt32LE(header.length);
const pack = Buffer.concat([Buffer.from('TLPK'), len, header, ...files.map((p) => fs.readFileSync(path.join(fullLib, p)))]);
const gz = (buf) => zlib.gzipSync(buf, { level: 9 });
const sizes = {};
function emit(rel, buf) { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), buf); sizes[rel] = buf.length; }

emit('lib.pack.gz', gz(pack));
emit('rt/lean.js', fs.readFileSync(path.join(rt, 'runtime/lean.js')));
emit('rt/lean.wasm.gz', gz(fs.readFileSync(path.join(rt, 'runtime/lean.wasm'))));
emit('rt/slim/lean.js', fs.readFileSync(path.join(rt, 'runtime/slim/lean.js')));
emit('rt/slim/lean.wasm.gz', gz(fs.readFileSync(path.join(rt, 'runtime/slim/lean.wasm'))));

const leanSource = fs.readFileSync(path.join(root, SOURCE), 'utf8');
if (/<\/script/i.test(leanSource)) throw new Error(`${SOURCE} must not contain "</script"`);
for (const f of fs.readdirSync(path.join(root, 'site'))) {
  if (f === 'index.html') {
    const html = fs.readFileSync(path.join(root, 'site', f), 'utf8');
    fs.writeFileSync(path.join(out, f), html.replace('__LEAN__', () => '\n' + leanSource));
  } else fs.copyFileSync(path.join(root, 'site', f), path.join(out, f));
}
fs.copyFileSync(path.join(root, SOURCE), path.join(out, SOURCE));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const build = {
  source: SOURCE,
  leanCommit: runtimeInfo.leanCommit,
  leanVersion: runtimeInfo.leanVersion,
  runtime: runtimeInfo.assetVersion,
  commit: process.env.GITHUB_SHA || null,
  builtAt: new Date().toISOString(),
  closure: { modules, ofModules: allOleans, files: files.length, rawBytes: pack.length },
  sizes,
  check: { ok: true, seconds: pass2.seconds, output: pass2.output },
};
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(build, null, 2));
for (const [k, v] of Object.entries(sizes)) console.log(`${(v / 1e6).toFixed(1).padStart(6)} MB  ${k}`);
fs.rmSync(staged, { recursive: true, force: true });
fs.rmSync(openLog, { force: true });
