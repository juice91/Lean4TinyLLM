# Lean4TinyLLM

**English** · [繁體中文](README.zh-TW.md)

> **▶ Try it live: [juice91.github.io/Lean4TinyLLM](https://juice91.github.io/Lean4TinyLLM/)**
>
> Nothing to install: step through the computation in your browser and check it with Lean there too (about 31 MB on first load).

A minimal autoregressive Transformer: 160 weights, computed step by step in your browser, then checked by Lean 4 running in the same tab.

- 1 attention layer, 1 ReLU MLP, one embedding table shared by input and output, greedy word choice
- d = 4, MLP width 8, a vocabulary of 8 words, no positional encoding
- Weights trained on one sentence, “the cat passed out on the piano .”, and rounded to one decimal place

## The page

`site/index.html` is one page of nine steps (①–⑨) that you page through with Back / Next:

1. lookup → 2. Q, K, V → 3. scores Sᵢⱼ and the causal mask → 4. softmax → 5. weighted V, residual, 2-D plot → 6. MLP → 7. logits → 8. Temperature / Top-K / Top-P sampling → 9. checking with Lean in the browser

Every step has its diagram, the full worked arithmetic, and the matching `TinyLLM.lean` code (this step's lines in yellow). Terms are numbered where they first appear, with a glossary at the bottom of the page.

The page is in English and Traditional Chinese. It picks the language from your browser (Traditional Chinese gets Chinese, everything else gets English); the switch at the top right changes it and remembers your choice. Add `?lang=en` or `?lang=zh-TW` to the URL to choose directly.

## Lean

`TinyLLM.lean` uses core Lean only, no Mathlib:

- three `#eval`s: the logits and probabilities after `<s> the`, and the fully decoded sentence
- `decodes_sentence`: checks with `native_decide` that the model decodes the whole sentence
- `no_peeking`: a proof for every input that appending words never changes earlier positions (the causal mask)
- `softmax_length`: softmax returns as many values as it is given

The file starts with `prelude` + `import Init.Data.OfScientific`, so it needs only 185 of the 629 modules in Lean's core library.

```bash
lean TinyLLM.lean
```

## Running Lean in the browser

The WebAssembly build of Lean comes from [cauli/lean4-wasm-in-browser](https://github.com/cauli/lean4-wasm-in-browser) (Apache-2.0), pinned in `runtime.json`. It needs SharedArrayBuffer, so the page must run with cross-origin isolation; on hosts that can't set HTTP headers (such as GitHub Pages), [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT, `site/coi-serviceworker.js`) provides it.

## Building

```bash
# 1. Download the pinned runtime and check its SHA-256 (see runtime.json)
curl -fsSL -o fixture.tar.gz "$(node -p 'require("./runtime.json").fixture.url')"
shasum -a 256 fixture.tar.gz   # should match the sha256 in runtime.json
mkdir -p rt && tar -xzf fixture.tar.gz -C rt

# 2. Build: check TinyLLM.lean twice with the WebAssembly lean (full library, then only
#    the 185 modules it uses), then package the site into dist/
node tools/build.mjs rt dist
```

`dist/` is a static site. The first visit downloads about 31 MB (`lean.wasm` 17 MB, library 13 MB, both compressed); later visits use the browser cache.

To test locally, serve it with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, or use any static server and let coi-serviceworker handle it (the page reloads once on the first visit).

## Retraining

```bash
node tools/train.js 2 > weights.json
```

Central-difference gradients, Adam, 3000 steps. Seed 2 produced the weights in `TinyLLM.lean`.

## Files

| File | Contents |
|---|---|
| `TinyLLM.lean` | the model, `#eval`s, three theorems |
| `site/index.html` | the step-by-step page |
| `site/i18n.js` | every piece of text on the page, in English and Chinese |
| `site/lean-worker.js` | runs the WebAssembly Lean in a Web Worker |
| `site/coi-serviceworker.js` | provides cross-origin isolation |
| `tools/build.mjs` | checks with Lean, finds the modules used, packages the site |
| `tools/lean-node.cjs` | runs the WebAssembly Lean in Node |
| `tools/train.js` | trains the weights |
| `runtime.json` | the pinned Lean WebAssembly version and hashes |
| `LICENSE`, `LICENSE-TEXT`, `THIRD_PARTY_LICENSES` | licenses |
