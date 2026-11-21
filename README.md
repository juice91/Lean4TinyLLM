# Lean4TinyLLM

> **▶ 線上試玩：[juice91.github.io/Lean4TinyLLM](https://juice91.github.io/Lean4TinyLLM/)**
>
> 不用安裝，打開就能一步一步看計算，並在瀏覽器裡用 Lean 檢查（第一次載入約 31 MB）。

一個最小的自迴歸 Transformer：160 個權重，在瀏覽器裡一步一步算給你看，最後直接在同一個分頁裡跑 Lean 4 檢查。

- 1 層 attention、1 個 ReLU MLP、輸入輸出共用嵌入表、greedy 選字
- d = 4、MLP 寬度 8、詞表 8 個字、沒有位置編碼
- 權重用一句話「the cat passed out on the piano .」訓練，四捨五入到小數一位

## 頁面

`site/index.html` 是一頁九個步驟（①–⑨），用「上一步／下一步」翻：

1. 查表 → 2. Q、K、V → 3. 分數 Sᵢⱼ 和 causal mask → 4. softmax → 5. 加權 V、殘差、2D 圖 → 6. MLP → 7. logits → 8. Temperature／Top-K／Top-P 抽樣 → 9. 在瀏覽器裡用 Lean 檢查

每一步都有圖例、完整算式，以及對應的 `TinyLLM.lean` 程式（黃色是這一步）。第一次出現的名詞有編號，註解在頁面最下面。

## Lean

`TinyLLM.lean` 只用 Lean 核心，不需要 Mathlib：

- 三個 `#eval`：`<s> the`之後的 logits、機率，以及完整解碼出的句子
- `decodes_sentence`：用 `native_decide` 檢查模型會解碼出整句
- `no_peeking`：對任何輸入都成立的證明，後面加字不會改變前面位置的結果（causal mask）
- `softmax_length`：softmax 輸出的長度等於輸入

檔案開頭是 `prelude` + `import Init.Data.OfScientific`，所以只需要 Lean 核心函式庫 629 個模組裡的 185 個。

```bash
lean TinyLLM.lean
```

## 在瀏覽器裡跑 Lean

Lean 的 WebAssembly 版本來自 [cauli/lean4-wasm-in-browser](https://github.com/cauli/lean4-wasm-in-browser)（Apache-2.0），版本固定在 `runtime.json`。它需要 SharedArrayBuffer，所以頁面要在 cross-origin isolation 下執行；在沒辦法加 HTTP 標頭的主機（例如 GitHub Pages）上，由 [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)（MIT，`site/coi-serviceworker.js`）補上。

## 建置

```bash
# 1. 下載固定版本的 runtime，並確認 SHA-256（見 runtime.json）
curl -fsSL -o fixture.tar.gz "$(node -p 'require("./runtime.json").fixture.url')"
shasum -a 256 fixture.tar.gz   # 應該是 runtime.json 裡的 sha256
mkdir -p rt && tar -xzf fixture.tar.gz -C rt

# 2. 建置：用 WebAssembly 的 lean 檢查 TinyLLM.lean 兩次（完整函式庫、只留用到的 185 個模組），
#    再打包到 dist/
node tools/build.mjs rt dist
```

`dist/` 是靜態網站。第一次開啟要下載約 31 MB（`lean.wasm` 17 MB、函式庫 13 MB，都壓縮過），之後用瀏覽器快取。

本機測試時，伺服器要送出 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`；或者用一般的靜態伺服器，讓 coi-serviceworker 處理（第一次會重新整理一次）。

## 重新訓練

```bash
node tools/train.js 2 > weights.json
```

用中央差分算梯度、Adam、3000 步。seed 2 就是 `TinyLLM.lean` 裡的權重。

## 檔案

| 檔案 | 內容 |
|---|---|
| `TinyLLM.lean` | 模型、`#eval`、三個定理 |
| `site/index.html` | 一步一步的頁面 |
| `site/lean-worker.js` | 在 Web Worker 裡跑 WebAssembly 的 Lean |
| `site/coi-serviceworker.js` | 補上 cross-origin isolation |
| `tools/build.mjs` | 檢查 Lean、找出用到的模組、打包網站 |
| `tools/lean-node.cjs` | 在 Node 裡跑 WebAssembly 的 Lean |
| `tools/train.js` | 訓練權重 |
| `runtime.json` | 固定的 Lean WebAssembly 版本和雜湊值 |
| `LICENSE`、`LICENSE-TEXT`、`THIRD_PARTY_LICENSES` | 授權 |

## 授權

- **程式碼**：[MIT](LICENSE)，© 2026 juice91
- **文字**（README、網頁上的解說、算式說明、名詞註解）：[CC BY 4.0](LICENSE-TEXT)。轉載或改編時請標註「Lean4TinyLLM by juice91」並附上這個 repo 的連結
- **第三方元件**維持原本的授權，見 [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)：Lean 4 的 WebAssembly 版本和改寫自 cauli/lean4-wasm-in-browser 的兩個檔案是 Apache-2.0，coi-serviceworker 是 MIT
