prelude
import Init.Data.OfScientific
/-!
# TinyLLM: a whole autoregressive Transformer forward pass in core Lean 4

One causal self-attention layer, one ReLU MLP, tied embeddings, greedy decoding.
d = 4, MLP width 8, vocabulary of 8 tokens, 160 weights rounded to one decimal.
The weights were fit to a single sentence, "the cat passed out on the piano ."
No Mathlib needed: paste into https://live.lean-lang.org and it runs.
-/

abbrev Vec := List Float
abbrev Mat := List (List Float)

def vocab : List String := ["<s>", "the", "cat", "passed", "out", "on", "piano", "."]

/-- token embeddings (8 × 4); also reused as the output layer ("tied") -/
def E : Mat := [
  [-0.3, -0.3, -0.3, 0.6],
  [-1.3, 0.8, -0.7, 0.6],
  [-0.5, 1.6, 0.3, -1.1],
  [0.5, -1.2, 0.4, -1.3],
  [0.8, -1.7, 0.2, 0.5],
  [-0.2, -0.6, -0.1, 1.3],
  [0.9, 0.3, -0.6, -1.2],
  [0.9, 0.8, 0.3, 0.2]]

def WQ : Mat := [
  [0.9, 0.2, 0.2, -0.4],
  [-0.8, 0.1, 0.1, 0.3],
  [-0.1, -0.1, -0.1, 0.1],
  [0.0, -0.7, -0.6, 0.2]]

def WK : Mat := [
  [0.2, 0.3, 0.2, -0.2],
  [-1.1, -0.3, -0.3, 0.5],
  [-0.1, 0.3, 0.2, -0.1],
  [0.5, -0.6, -0.5, 0.0]]

def WV : Mat := [
  [0.1, 0.5, 0.8, -0.3],
  [-0.5, -0.2, -1.1, 1.0],
  [-0.1, 0.4, 0.3, 0.2],
  [0.5, -1.1, -0.2, -1.0]]

def WO : Mat := [
  [-0.2, 0.4, 0.1, 0.6],
  [1.2, -0.4, 0.4, -0.2],
  [0.9, 0.2, 0.7, 0.8],
  [0.4, -0.7, -0.3, -1.2]]

/-- MLP up-projection (4 × 8) -/
def W1 : Mat := [
  [0.1, 0.0, 0.4, -0.4, -0.4, 0.9, -0.8, -0.6],
  [-0.2, 0.0, -0.6, -0.1, -0.1, 0.2, 0.1, 0.1],
  [0.0, 0.0, 0.1, 0.2, -0.5, 0.3, -0.5, -0.3],
  [-0.3, 0.0, -0.9, 0.9, -0.6, 0.3, 0.1, 0.1]]

/-- MLP down-projection (8 × 4) -/
def W2 : Mat := [
  [0.1, -0.3, 0.0, 0.0],
  [0.0, 0.0, 0.0, 0.0],
  [0.3, -1.1, -0.1, 0.2],
  [-0.7, -0.1, -0.3, 0.7],
  [0.6, 0.1, -0.2, -0.6],
  [0.5, 0.5, 0.2, 0.6],
  [0.0, 0.8, -0.3, -0.3],
  [0.0, 0.6, -0.3, -0.2]]

/-! ## Linear algebra on lists -/

def dot (a b : Vec) : Float := (List.zipWith (· * ·) a b).foldl (· + ·) 0
def addV (a b : Vec) : Vec := List.zipWith (· + ·) a b
def scale (c : Float) (v : Vec) : Vec := v.map (c * ·)
def zeros (n : Nat) : Vec := List.replicate n 0

/-- row vector times matrix: v · M = Σᵢ vᵢ · (row i of M) -/
def vecMat (v : Vec) (M : Mat) : Vec :=
  (List.zipWith scale v M).foldl addV (zeros (M.headD []).length)

def relu (v : Vec) : Vec := v.map fun x => if x > 0 then x else 0

def softmax (xs : List Float) : List Float :=
  let m := xs.foldl max (xs.headD 0)
  let es := xs.map fun x => Float.exp (x - m)
  let s := es.foldl (· + ·) 0
  es.map (· / s)

/-! ## The transformer block -/

/-- Self-attention for the LAST vector of `ctx`, looking only at `ctx`. -/
def attend (ctx : List Vec) : Vec :=
  let x := ctx.getLastD (zeros 4)
  let q := vecMat x WQ
  let scores := ctx.map fun c => dot q (vecMat c WK) / Float.sqrt 4
  let w := softmax scores
  let mix := (List.zipWith (fun wj c => scale wj (vecMat c WV)) w ctx).foldl addV (zeros 4)
  addV x (vecMat mix WO)                       -- residual

/-- attention, then MLP, each with a residual connection -/
def block (ctx : List Vec) : Vec :=
  let h := attend ctx
  addV h (vecMat (relu (vecMat h W1)) W2)      -- residual

/-- The causal mask: position `i` is computed from the first `i+1` vectors only. -/
def blockAt (xs : List Vec) (i : Nat) : Vec := block (xs.take (i + 1))

def embed (toks : List Nat) : List Vec := toks.map fun t => E.getD t (zeros 4)

/-- next-token scores: last hidden state dotted with every token embedding -/
def logits (toks : List Nat) : List Float :=
  let xs := embed toks
  E.map (dot (blockAt xs (xs.length - 1)))

def argmax (xs : List Float) : Nat :=
  (List.range xs.length).foldl (fun best j => if xs.getD j 0 > xs.getD best 0 then j else best) 0

/-- greedy decoding, stopping at "." (token 7) -/
def generate : Nat → List Nat → List Nat
  | 0, toks => toks
  | n + 1, toks =>
    let next := argmax (logits toks)
    if next == 7 then toks ++ [next] else generate n (toks ++ [next])

def detok (toks : List Nat) : String := " ".intercalate (toks.map (vocab.getD · "?"))

/-! ## Run it -/

#eval logits [0, 1]                      -- scores after "<s> the"
#eval softmax (logits [0, 1])            -- probabilities after "<s> the"
#eval detok (generate 9 [0, 1])           -- "<s> the cat passed out on the piano ."

/-! ## Check it -/

/-- Compiled-code check of the whole decode. -/
theorem decodes_sentence : generate 9 [0, 1] = [0, 1, 2, 3, 4, 5, 1, 6, 7] := by native_decide

/-- Causality, proved for every input: appending future tokens never changes
    the hidden state at an earlier position. -/
theorem no_peeking (xs ys : List Vec) (i : Nat) (h : i < xs.length) :
    blockAt (xs ++ ys) i = blockAt xs i := by
  unfold blockAt
  rw [List.take_append_of_le_length (by omega)]

theorem softmax_length (xs : List Float) : (softmax xs).length = xs.length := by
  simp [softmax]
