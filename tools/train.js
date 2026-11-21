// Usage: node tools/train.js [seed] > weights.json   (seed 1 produced the weights in TinyLLM.lean)
// Train a tiny 1-layer transformer (d=4, hidden=8, vocab=7, no positional embeddings,
// tied embeddings) on one sentence, with finite-difference gradients + Adam,
// then round weights to 1 decimal and check greedy generation still works.
const VOCAB = ["<s>", "the", "cat", "sat", "on", "mat", "."];
const SEQ = [0, 1, 2, 3, 4, 1, 5, 6];
const D = 4, H = 8, V = VOCAB.length;

const shapes = { E: [V, D], WQ: [D, D], WK: [D, D], WV: [D, D], WO: [D, D], W1: [D, H], W2: [H, D] };
const names = Object.keys(shapes);
const sizes = names.map(n => shapes[n][0] * shapes[n][1]);
const N = sizes.reduce((a, b) => a + b, 0);

function unpack(theta) {
  const P = {}; let o = 0;
  names.forEach((n, k) => {
    const [r, c] = shapes[n]; const M = [];
    for (let i = 0; i < r; i++) { M.push(Array.from(theta.slice(o, o + c))); o += c; }
    P[n] = M;
  });
  return P;
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const vecMat = (v, M) => M[0].map((_, j) => v.reduce((s, vi, i) => s + vi * M[i][j], 0));
const add = (a, b) => a.map((x, i) => x + b[i]);
const softmax = xs => { const m = Math.max(...xs); const e = xs.map(x => Math.exp(x - m)); const s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
const relu = v => v.map(x => Math.max(0, x));

function forward(P, toks) {
  const xs = toks.map(t => P.E[t]);
  return xs.map((x, i) => {
    const ctx = xs.slice(0, i + 1);
    const q = vecMat(x, P.WQ);
    const ks = ctx.map(c => vecMat(c, P.WK));
    const vs = ctx.map(c => vecMat(c, P.WV));
    const w = softmax(ks.map(k => dot(q, k) / Math.sqrt(D)));
    const mix = vs.reduce((acc, v, j) => add(acc, v.map(y => y * w[j])), Array(D).fill(0));
    const h = add(x, vecMat(mix, P.WO));
    const m = add(h, vecMat(relu(vecMat(h, P.W1)), P.W2));
    return P.E.map(e => dot(m, e));
  });
}

function loss(theta) {
  const P = unpack(theta);
  const L = forward(P, SEQ.slice(0, -1));
  let s = 0;
  L.forEach((lg, i) => { const p = softmax(lg); s -= Math.log(p[SEQ[i + 1]]); });
  let reg = 0; for (const x of theta) reg += x * x;
  return s / L.length + 1e-3 * reg;
}

function margin(P) {
  const L = forward(P, SEQ.slice(0, -1));
  return Math.min(...L.map((lg, i) => { const t = SEQ[i + 1]; const others = lg.filter((_, j) => j !== t); return lg[t] - Math.max(...others); }));
}

function generate(P, prompt, maxLen = 8) {
  const toks = [...prompt];
  while (toks.length < maxLen) {
    const lg = forward(P, toks).at(-1);
    const nxt = lg.indexOf(Math.max(...lg));
    toks.push(nxt);
    if (nxt === 6) break;
  }
  return toks;
}

let seed = +(process.argv[2] || 1);
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
let theta = Float64Array.from({ length: N }, () => (rand() - 0.5) * 1.0);
const m = new Float64Array(N), v = new Float64Array(N);
const lr = 0.03, b1 = 0.9, b2 = 0.999, eps = 1e-8, hstep = 1e-5;
for (let step = 1; step <= 3000; step++) {
  const g = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const o = theta[i];
    theta[i] = o + hstep; const lp = loss(theta);
    theta[i] = o - hstep; const lm = loss(theta);
    theta[i] = o; g[i] = (lp - lm) / (2 * hstep);
  }
  for (let i = 0; i < N; i++) {
    m[i] = b1 * m[i] + (1 - b1) * g[i]; v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
    const mh = m[i] / (1 - b1 ** step), vh = v[i] / (1 - b2 ** step);
    theta[i] -= lr * mh / (Math.sqrt(vh) + eps);
  }
  if (step % 500 === 0) console.error("step", step, "loss", loss(theta).toFixed(4));
}
const rounded = Float64Array.from(theta, x => Math.round(x * 10) / 10);
const P = unpack(rounded);
console.error("rounded margin", margin(P).toFixed(3));
console.error("gen from <s> the:", generate(P, [0, 1]).map(t => VOCAB[t]).join(" "));
console.error("gen from <s>:", generate(P, [0]).map(t => VOCAB[t]).join(" "));
console.log(JSON.stringify(P));
