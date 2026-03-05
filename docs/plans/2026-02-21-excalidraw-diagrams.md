# Excalidraw Architecture Diagrams Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create 5 Excalidraw architecture diagrams for Aegis covering system overview, deposit/withdrawal flow, crypto key model, JoinSplit circuit, and FROST signing.

**Architecture:** Each diagram is a standalone `.excalidraw` JSON file in `docs/diagrams/`. Files use Excalidraw v2 format with rectangle, text, arrow, ellipse, and diamond elements. A helper TypeScript script generates the JSON programmatically for maintainability.

**Tech Stack:** TypeScript generator script (run with `bun`), Excalidraw JSON v2 format

---

### Task 1: Create generator helper and directory structure

**Files:**
- Create: `docs/diagrams/` directory
- Create: `docs/diagrams/generate.ts` — helper functions for Excalidraw element creation

**Step 1: Create directory**
```bash
mkdir -p docs/diagrams
```

**Step 2: Write the generator helper**

Create `docs/diagrams/generate.ts` with:
- `makeId()` — generates random 10-char IDs
- `rect(id, x, y, w, h, opts)` — creates rectangle element with label, backgroundColor, strokeColor, roundness
- `text(id, x, y, content, opts)` — creates text element with fontSize, fontFamily
- `arrow(id, x, y, points, opts)` — creates arrow element with start/end points
- `line(id, x, y, points, opts)` — creates line element
- `diamond(id, x, y, w, h, opts)` — creates diamond element
- `ellipse(id, x, y, w, h, opts)` — creates ellipse element
- `group(elements, groupId)` — adds groupId to all elements
- `wrapFile(elements)` — wraps elements in `{ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null } }`
- `writeExcalidraw(filename, elements)` — writes JSON to file

Each element factory should produce a complete Excalidraw element object:
```typescript
interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;           // 0
  strokeColor: string;     // "#1e1e1e"
  backgroundColor: string; // "transparent"
  fillStyle: string;       // "solid"
  strokeWidth: number;     // 2
  strokeStyle: string;     // "solid"
  roughness: number;       // 1
  opacity: number;         // 100
  groupIds: string[];      // []
  frameId: null;
  index: string;           // e.g. "a0", "a1"
  roundness: { type: number } | null;  // { type: 3 } for rounded
  seed: number;            // random int
  version: number;         // 1
  versionNonce: number;    // random int
  isDeleted: boolean;      // false
  boundElements: null | Array<{ id: string; type: string }>;
  updated: number;         // Date.now()
  link: null;
  locked: boolean;         // false
}
```

Text elements additionally need: `text`, `fontSize` (default 20), `fontFamily` (1=Virgil, 2=Helvetica, 3=Cascadia), `textAlign` ("center"), `verticalAlign` ("middle"), `containerId` (null or parent ID), `originalText`, `autoResize` (true), `lineHeight` (1.25).

Arrow elements additionally need: `points` array of `[dx, dy]` offsets, `startBinding`/`endBinding` (null or `{ elementId, focus, gap, fixedPoint }`), `startArrowhead`/`endArrowhead` (null or "arrow").

**Step 3: Verify helper compiles**
```bash
cd docs/diagrams && bun run generate.ts --help
```

**Step 4: Commit**
```bash
git add docs/diagrams/generate.ts
git commit -m "feat: add Excalidraw diagram generator helper"
```

---

### Task 2: System Overview diagram

**Files:**
- Create: `docs/diagrams/system-overview.excalidraw`
- Modify: `docs/diagrams/generate.ts` — add `generateSystemOverview()` function

**Layout spec (canvas ~1400x900):**

Three horizontal color-coded bands:

**Bitcoin Layer (y=0, h=220, bg=#fff3e0 orange tint):**
- Band label: "BITCOIN LAYER" at top-left
- Boxes: "User Wallet" → "Taproot Address" → "Bitcoin Network" → "Header Relayer"
- Arrows connecting them left-to-right
- Arrow from Header Relayer down to Solana layer

**Solana Layer (y=260, h=300, bg=#f3e5f5 purple tint):**
- Band label: "SOLANA LAYER"
- Left box: "BTC Light Client" with sub-label "(SPV Verification)"
- Right large box: "Aegis Program" containing 5 smaller boxes:
  - "Commitment Tree (depth 16)"
  - "Nullifier Registry"
  - "Stealth Announcements"
  - "Name Registry (.zkey)"
  - "VK Registry"
- Arrow: BTC Light Client ↔ Aegis Program

**Client Layer (y=600, h=250, bg=#e3f2fd blue tint):**
- Band label: "CLIENT LAYER"
- Central box: "@aegis/sdk" with sub-label "(Note Mgmt | Proofs | Stealth | Taproot)"
- Below SDK, 4 boxes in a row:
  - "Web App (Next.js)"
  - "Mobile App (Expo)"
  - "Backend (Rust API)"
  - "FROST Server"
- Arrows from SDK to each client
- Arrow from Solana layer down to SDK

**Step 1: Add generateSystemOverview() to generate.ts**

Implement the function creating all elements per the layout spec above. Use the helper functions from Task 1.

**Step 2: Run generator**
```bash
cd docs/diagrams && bun run generate.ts system-overview
```

**Step 3: Verify file opens in Excalidraw**
Open `docs/diagrams/system-overview.excalidraw` at https://excalidraw.com — verify layout matches spec.

**Step 4: Commit**
```bash
git add docs/diagrams/system-overview.excalidraw
git commit -m "feat: add system overview Excalidraw diagram"
```

---

### Task 3: Deposit & Withdrawal Flow diagram

**Files:**
- Create: `docs/diagrams/deposit-withdraw-flow.excalidraw`
- Modify: `docs/diagrams/generate.ts` — add `generateDepositWithdrawFlow()`

**Layout spec (canvas ~1800x800):**

Three horizontal swimlanes:

**Deposit Flow (y=0, h=220, green #e8f5e9):**
- Label: "DEPOSIT FLOW" (green)
- Steps (rounded rects, left to right):
  1. "Generate Keys (BJJ + Ed25519)"
  2. "Derive Taproot Address"
  3. "Send BTC"
  4. "6+ Block Confirmations"
  5. "Header Relayer Syncs"
  6. "SPV Verify on Solana"
  7. "Stealth Announcement"
  8. "Recipient Scans"
  9. "JoinSplit 1x2 Claim"
  10. "Commitment in Merkle Tree"
- Green arrows connecting each step
- Checkmark icon at end

**Private Transfer (y=260, h=180, blue #e3f2fd):**
- Label: "PRIVATE TRANSFER"
- Steps:
  1. "Sender has Commitment"
  2. "Generate JoinSplit 2x2 Proof"
  3. "Transact Instruction"
  4. "Old Nullifiers Published"
  5. "New Commitments Inserted"
  6. "Stealth Announcement"
- Blue arrows

**Withdrawal Flow (y=480, h=220, red #fce4ec):**
- Label: "WITHDRAWAL FLOW"
- Steps:
  1. "Request Redemption"
  2. "Nullifier Published"
  3. "zBTC Burned from Pool"
  4. "FROST Server: 2-of-3 Signing"
  5. "BTC Transaction Broadcast"
  6. "Complete Redemption"
- Red arrows
- Annotation boxes (dashed): "ZK Proof" near claim, "Groth16 ~256 bytes" near transact, "Schnorr (BIP-340)" near FROST

**Step 1: Add generateDepositWithdrawFlow() to generate.ts**
**Step 2: Run generator**
```bash
cd docs/diagrams && bun run generate.ts deposit-withdraw-flow
```
**Step 3: Verify in Excalidraw**
**Step 4: Commit**
```bash
git add docs/diagrams/deposit-withdraw-flow.excalidraw
git commit -m "feat: add deposit/withdrawal flow Excalidraw diagram"
```

---

### Task 4: Cryptography & Key Model diagram

**Files:**
- Create: `docs/diagrams/crypto-key-model.excalidraw`
- Modify: `docs/diagrams/generate.ts` — add `generateCryptoKeyModel()`

**Layout spec (canvas ~1600x900):**

Two sections side by side:

**Section A — Key Hierarchy (left half, x=0..700):**
- Top: Diamond "Spending Key (Baby Jubjub)" in green
- Three branches down:
  - Green rect: "Spending Pub (BJJ point)"
  - Orange rect: "Nullifying Key (BN254 scalar)"
  - Blue rect: "Viewing Key (Ed25519)"
- These three converge into:
  - Ellipse: "MPK = Poseidon(spendPub.x, spendPub.y, nullKey)"
- Down arrow to:
  - Ellipse: "NPK = Poseidon(MPK, random)"
- Two branches:
  - Rect: "Commitment = Poseidon(NPK, token, amount)" → "Merkle Tree (depth 16)"
  - Rect: "Nullifier = Poseidon(nullifyingKey, leafIndex)" → "Nullifier Registry"

**Section B — Stealth Address Protocol (right half, x=800..1600):**
- Title: "Stealth Address Protocol (EIP-5564)"
- Two columns: SENDER (left) and RECIPIENT (right)
- SENDER column:
  - "eph_priv (Ed25519)" → "eph_pub"
  - Arrow to center: "On-Chain Announcement (90 bytes)"
  - "X25519 ECDH" → "shared_secret"
  - "stealth_pub (BJJ)"
  - "commitment"
- RECIPIENT column:
  - "viewing_priv (Ed25519)"
  - Gets eph_pub from announcement
  - "X25519 ECDH" → "shared_secret" (same!)
  - "stealth_pub (BJJ)"
  - "scan + detect + claim with ZK proof"
- Dashed connecting lines showing shared_secret derivation converges

**Step 1: Add generateCryptoKeyModel() to generate.ts**
**Step 2: Run generator**
```bash
cd docs/diagrams && bun run generate.ts crypto-key-model
```
**Step 3: Verify in Excalidraw**
**Step 4: Commit**
```bash
git add docs/diagrams/crypto-key-model.excalidraw
git commit -m "feat: add crypto key model Excalidraw diagram"
```

---

### Task 5: JoinSplit Circuit diagram

**Files:**
- Create: `docs/diagrams/joinsplit-circuit.excalidraw`
- Modify: `docs/diagrams/generate.ts` — add `generateJoinSplitCircuit()`

**Layout spec (canvas ~1200x900):**

Large rounded rectangle as "circuit boundary" (dashed border):

**Title**: "JoinSplit(N, M, depth=16) Circuit" at top

**Private Inputs (left column, y=80, gray bg #f5f5f5):**
- "spendingKey (BJJ)"
- "nullifyingKey"
- "random[M]"
- "amount[N+M]"
- "token"
- "merklePathElements[N][16]"
- "merklePathIndices[N][16]"

**Public Inputs (right column, y=80, blue bg #e3f2fd):**
- "merkleRoot"
- "boundParamsHash"
- "nullifiers[N]"
- "commitmentsOut[M]"

**Verification Steps (center, 2x3 grid of numbered boxes):**
Row 1:
1. "MPK Check" — "spendingPub matches MPK derivation" (green border)
2. "Merkle Proof" — "Verify each input in tree (depth 16)" (green border)
3. "Nullifier Derivation" — "Poseidon(nullKey, leafIndex)" (orange border)

Row 2:
4. "Output Commitments" — "Poseidon(NPK, token, amount) + 120-bit range check" (blue border)
5. "Value Balance" — "Σ valueIn == Σ valueOut" (red border, important)
6. "EdDSA-Poseidon Signature" — "Sign(merkleRoot, boundParams, nullifiers, commitments)" (purple border)

Arrows: Steps 1→2→3→4→5→6 in flow order.

**Output (bottom, highlighted):**
- "Groth16 Proof: 256 bytes (2×G1 + 1×G2 on BN254)"
- "Verified on-chain via alt_bn128 pairing syscalls (~85,000 CU)"

**Step 1: Add generateJoinSplitCircuit() to generate.ts**
**Step 2: Run generator**
```bash
cd docs/diagrams && bun run generate.ts joinsplit-circuit
```
**Step 3: Verify in Excalidraw**
**Step 4: Commit**
```bash
git add docs/diagrams/joinsplit-circuit.excalidraw
git commit -m "feat: add JoinSplit circuit Excalidraw diagram"
```

---

### Task 6: FROST Threshold Signing diagram

**Files:**
- Create: `docs/diagrams/frost-signing.excalidraw`
- Modify: `docs/diagrams/generate.ts` — add `generateFrostSigning()`

**Layout spec (canvas ~1400x900):**

Two sections stacked vertically:

**Section A — DKG (top, y=0..350, bg #fff8e1):**
- Title: "Distributed Key Generation (DKG)"
- Three vertical columns for Signer 1, Signer 2, Signer 3 (person icons or labeled boxes)
- Row 1: "Round 1: Generate Commitments" — broadcast arrows between all signers
- Row 2: "Round 2: Encrypted Key Shares" — pairwise arrows with label "X25519/AES-GCM"
- Result at bottom: "Group Public Key (Taproot-compatible secp256k1)"

**Section B — Signing (bottom, y=400..900, bg #e8eaf6):**
- Title: "Redemption Signing (2-of-3)"
- Left: "Backend" box → arrow → "Policy Engine" (shield-shaped or hexagon):
  - Checklist items inside: "Sighash matches UTXO", "Destination whitelisted", "Amount/fee within limits"
- Right: Two signer columns (Signer 1, Signer 2) with "(threshold = 2)" label
  - Row 1: "Round 1: Nonce Commitments"
  - Row 2: "Round 2: Signature Shares"
- Merge: Arrow from both signers → "Aggregate" box → "Schnorr Signature (BIP-340)"
- Final: Arrow → "BTC Transaction Broadcast"
- Bottom annotation: "Audit: Append-only JSONL log for all operations"

**Step 1: Add generateFrostSigning() to generate.ts**
**Step 2: Run generator**
```bash
cd docs/diagrams && bun run generate.ts frost-signing
```
**Step 3: Verify in Excalidraw**
**Step 4: Commit**
```bash
git add docs/diagrams/frost-signing.excalidraw
git commit -m "feat: add FROST signing Excalidraw diagram"
```

---

### Task 7: Add `generate-all` command and final verification

**Files:**
- Modify: `docs/diagrams/generate.ts` — add "all" command

**Step 1: Add "all" command to generator**
When called with `bun run generate.ts all`, runs all 5 generators.

**Step 2: Run full generation**
```bash
cd docs/diagrams && bun run generate.ts all
```

**Step 3: Verify all 5 files exist and have reasonable sizes**
```bash
ls -la docs/diagrams/*.excalidraw
```
Each file should be 10-50 KB.

**Step 4: Final commit**
```bash
git add docs/diagrams/
git commit -m "feat: complete all 5 Excalidraw architecture diagrams"
```
