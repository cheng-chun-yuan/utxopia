# Test Coverage Plan

**Goal:** Fill SDK unit test gaps and add frontend component tests. Target: cover all pure-function modules with unit tests.

**Approach:** Test pure functions and deterministic logic first (highest value, no mocks needed). Skip modules that need live connections (announcement-client, sns-resolver) — those are covered by integration tests.

---

## SDK Unit Tests (Priority Order)

### Task 1: utils/encoding.ts tests
Pure functions: `toHex`, `fromHex`, `fromBase64`, `base64ToBinaryString`
Simple roundtrip + edge case tests. ~30 lines.

### Task 2: claim-link.ts tests
Pure functions: `encodeClaimLink`, `decodeClaimLink`, `parseClaimUrl`
URL encoding roundtrip + malformed input. ~40 lines.

### Task 3: merkle.ts tests
Pure functions: `pathIndicesToLeafIndex`, `leafIndexToPathIndices`, `validateMerkleProofStructure`, `createEmptyMerkleProof`, `proofToCircomFormat`
Index conversions, proof validation, format conversion. ~60 lines.

### Task 4: pda.ts tests
Pure functions: all `derive*PDA()` functions, `commitmentToBytes`
Deterministic PDA derivation — same inputs = same outputs. ~80 lines.

### Task 5: note.ts tests
Pure functions: `serializeNote/deserializeNote`, `formatBtc/parseBtc`, `estimateSeedStrength`, `noteHasComputedHashes`
Serialization roundtrip, BTC formatting, entropy estimation. ~60 lines.

### Task 6: taproot.ts tests
Pure functions: `isValidBitcoinAddress`, `createOpReturnScript`, `parseOpReturnCommitment`, `buildDepositOpReturn/parseDepositOpReturn`, `buildMockBtcTransaction`
Address validation, OP_RETURN roundtrip. ~80 lines.

### Task 7: psbt.ts tests
Pure functions: `selectUtxos`, `estimateDepositFee`
UTXO selection algorithm edge cases, fee estimation. ~60 lines.

### Task 8: keys.ts tests
Pure functions: `deriveKeysFromSeed`, `serializeStealthMetaAddress/deserializeStealthMetaAddress`, `createDelegatedViewKey`, `hasPermission`, `constantTimeCompare`, `clearKey`
Deterministic derivation, serialization roundtrip, permission checks. ~80 lines.

### Task 9: stealth.ts tests
Pure functions: `encryptAmount/decryptAmount`, `encryptNoteData/decryptNoteData`
Encryption roundtrip with known shared secrets. ~50 lines.

### Task 10: stealth-deposit.ts tests
Pure functions: `buildStealthOpReturn/parseStealthOpReturn`
OP_RETURN roundtrip with known data. ~40 lines.

## Frontend Component Tests

### Task 11: Frontend hook tests
Test the new extracted hooks with mock data:
- `useRelayerConfig` — mock fetch, verify fee computation
- `useTokenBalance` — mock connection, verify balance state

---

## Verification

After all tasks: `bun test` from project root should pass all SDK + app tests.
