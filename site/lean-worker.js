// Runs `lean TinyLLM.lean` once, inside this Web Worker, using the WebAssembly
// build of Lean from cauli/lean4-wasm-in-browser (Apache-2.0). Adapted from that
// repo's public/lean-worker-oneshot.worker.js.
//
// Protocol: postMessage({ type: 'run', code, variant: 'full' | 'slim' })
//   -> { type: 'phase', text }            what is happening now
//   -> { type: 'download', loaded, total } bytes fetched so far (compressed)
//   -> { type: 'modules', loaded, total }  .olean modules imported
//   -> { type: 'stdout' | 'stderr', data } Lean's own output
//   -> { type: 'done', exitCode, hasErrors, seconds }

const here = new URL('./', self.location.href).href;
const DEBUG = /^\s*\[(WASM DEBUG|DEBUG|IFRAME|PROFILE|PWORKER|COMPILE)/;

async function fetchGz(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.byteLength);
  }
  const gunzipped = new Blob(chunks).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(gunzipped).arrayBuffer());
}

function unpack(buf) {
  const magic = new TextDecoder().decode(buf.subarray(0, 4));
  if (magic !== 'TLPK') throw new Error('lib.pack.gz is not a TinyLLM library pack');
  const headerLen = new DataView(buf.buffer, buf.byteOffset + 4, 4).getUint32(0, true);
  const list = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + headerLen)));
  let off = 8 + headerLen;
  return list.map(([path, size]) => { const data = buf.subarray(off, off + size); off += size; return { path, data }; });
}

// Desktop gets 2 GB of shared wasm memory; iOS kills tabs that commit that much.
function pickWasmMemory() {
  const PAGE = 65536;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  for (const mb of isIOS ? [1024, 768, 512] : [2048, 1536, 1024, 768]) {
    try {
      return { memory: new WebAssembly.Memory({ initial: (mb << 20) / PAGE, maximum: 32768, shared: true }), bytes: mb << 20 };
    } catch (e) { /* try smaller */ }
  }
  return null;
}

function mkdirp(FS, dir) {
  let cur = '';
  for (const part of dir.split('/').filter(Boolean)) { cur += '/' + part; try { FS.mkdir(cur); } catch (e) {} }
}

function runMain(args) {
  if (typeof Module.callMain === 'function') return Module.callMain(args);
  const argv = ['lean'].concat(args).map((a) => Module.stringToNewUTF8(a));
  const ptr = Module._malloc(4 * (argv.length + 1));
  argv.forEach((p, i) => Module.setValue(ptr + 4 * i, p, 'i32'));
  Module.setValue(ptr + 4 * argv.length, 0, 'i32');
  return Module.ccall('main', 'number', ['number', 'number'], [argv.length, ptr]);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== 'run') return;
  const t0 = performance.now();
  const rt = here + (msg.variant === 'slim' ? 'rt/slim/' : 'rt/');
  const post = (m) => self.postMessage(m);

  let lib, wasm;
  try {
    post({ type: 'phase', text: 'Downloading Lean and its library' });
    let loaded = 0;
    const tick = (n) => { loaded += n; post({ type: 'download', loaded }); };
    [lib, wasm] = await Promise.all([fetchGz(here + 'lib.pack.gz', tick), fetchGz(rt + 'lean.wasm.gz', tick)]);
    lib = unpack(lib);
  } catch (e) {
    post({ type: 'stderr', data: 'Download failed: ' + (e && e.message || e) });
    post({ type: 'done', exitCode: 1, hasErrors: true, seconds: (performance.now() - t0) / 1000 });
    return;
  }

  post({ type: 'phase', text: 'Starting the Lean runtime' });
  let hasErrors = null, echo = false;
  const onLine = (stream) => (text) => {
    if (DEBUG.test(text)) {
      post({ type: 'debug', data: text });
      echo = /Input file content/.test(text);
      const p = /\[DEBUG:PROGRESS\]\s*(\d+)\/(\d+)/.exec(text);
      if (p) post({ type: 'modules', loaded: +p[1], total: +p[2] });
      else if (/\[DEBUG:PROGRESS\] Loading \d+ modules/.test(text)) post({ type: 'phase', text: 'Importing the library' });
      if (/About to run and report/.test(text)) post({ type: 'phase', text: 'Elaborating TinyLLM.lean' });
      const h = /hasErrors = (true|false)/.exec(text);
      if (h) hasErrors = h[1] === 'true';
      return;
    }
    if (echo) return;
    post({ type: stream, data: text });
  };

  // The glue fetches `lean.wasm` by name; hand it the decompressed bytes instead.
  const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
  wasm = null;
  // Lean's 4 thread workers are started from inside this worker. Some browsers
  // (embedded Chromium views among them) refuse nested workers loaded from a
  // URL but allow them from a blob: URL, so the threads get a blob copy.
  let leanJsUrl;
  try {
    const js = await (await fetch(rt + 'lean.js')).text();
    leanJsUrl = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
  } catch (e) {
    post({ type: 'stderr', data: 'Could not load lean.js: ' + (e && e.message || e) });
    post({ type: 'done', exitCode: 1, hasErrors: true, seconds: (performance.now() - t0) / 1000 });
    return;
  }
  const mem = pickWasmMemory();
  self.Module = {
    ...(mem ? { wasmMemory: mem.memory, INITIAL_MEMORY: mem.bytes } : {}),
    locateFile: (f) => (f.endsWith('.wasm') ? wasmUrl : rt + f),
    mainScriptUrlOrBlob: leanJsUrl,
    noInitialRun: true,
    setStatus: (t) => t && post({ type: 'debug', data: '[status] ' + t }),
    monitorRunDependencies: (n) => post({ type: 'debug', data: '[run deps left] ' + n }),
    print: onLine('stdout'),
    printErr: onLine('stderr'),
    preRun: [function () {
      const FS = Module.FS;
      Module.ENV.LEAN_PATH = '/lib/lean';
      for (const d of ['/lib', '/lib/lean', '/workspace', '/bin']) { try { FS.mkdir(d); } catch (e) {} }
      for (const f of lib) {
        const full = '/lib/lean/' + f.path;
        mkdirp(FS, full.slice(0, full.lastIndexOf('/')));
        FS.writeFile(full, f.data);
      }
      FS.writeFile('/workspace/TinyLLM.lean', msg.code);
      FS.chdir('/workspace');
    }],
    onRuntimeInitialized: function () {
      post({ type: 'debug', data: '[runtime initialized]' });
      setTimeout(function () {
        let exitCode = 0;
        try {
          const r = runMain(['TinyLLM.lean']);
          if (typeof r === 'number') exitCode = r;
        } catch (e) {
          if (typeof e === 'number') exitCode = e;
          else if (e && e.name === 'ExitStatus') exitCode = e.status;
          else { post({ type: 'stderr', data: 'Error: ' + (e && e.message || e) }); exitCode = 1; }
        }
        post({ type: 'done', exitCode, hasErrors: hasErrors !== false || exitCode !== 0, seconds: (performance.now() - t0) / 1000 });
      }, 0);
    },
    onAbort: function (what) {
      post({ type: 'stderr', data: 'Lean aborted: ' + (what || 'unknown reason') });
      post({ type: 'done', exitCode: 1, hasErrors: true, seconds: (performance.now() - t0) / 1000 });
    },
  };

  post({ type: 'debug', data: '[memory] ' + (mem ? (mem.bytes >> 20) + ' MB shared' : 'none') + ', crossOriginIsolated=' + self.crossOriginIsolated });
  try {
    importScripts(leanJsUrl);
    post({ type: 'debug', data: '[lean.js loaded]' });
  } catch (e) {
    post({ type: 'stderr', data: 'Could not load lean.js: ' + (e && e.message || e) });
    post({ type: 'done', exitCode: 1, hasErrors: true, seconds: (performance.now() - t0) / 1000 });
  }
};
