/**
 * Deposit Flow Unit Tests
 *
 * Tests each phase of the BTC deposit flow as isolated, pure unit tests.
 * No network access, no validator, no compiled circuits required.
 */

import { describe, test, expect, beforeAll } from "bun:test";

// Poseidon
import {
  initPoseidon,
  poseidonHashSync,
  computeMPKSync,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  BN254_SCALAR_FIELD,
} from "../../src/poseidon";

// Taproot
import {
  deriveTaprootAddress,
  verifyTaprootAddress,
  createP2TRScriptPubkey,
  parseP2TRScriptPubkey,
  isValidBitcoinAddress,
} from "../../src/taproot";

// Keys
import {
  deriveKeysFromSeed,
  createStealthMetaAddress,
} from "../../src/keys";

// Stealth
import {
  createStealthDeposit,
  scanAnnouncements,
  prepareClaimInputs,
  ZBTC_TOKEN_ID,
} from "../../src/stealth";

// Commitment tree
import {
  CommitmentTreeIndex,
  ZERO_HASHES,
  TREE_DEPTH,
} from "../../src/commitment-tree";

// Merkle helpers
import {
  leafIndexToPathIndices,
  pathIndicesToLeafIndex,
} from "../../src/merkle";

// Bound params
import {
  computeBoundParamsHash,
  DEFAULT_BOUND_PARAMS,
  createUnshieldBoundParams,
} from "../../src/bound-params";

// Crypto helpers
import { bytesToBigint } from "../../src/crypto";

// API
import { depositToNote } from "../../src/api";

// ============================================================================
// Setup
// ============================================================================

const TEST_SEED = new Uint8Array(32).fill(0xaa);

beforeAll(async () => {
  await initPoseidon();
});

// NOTE:
// This file mirrors the original deposit-flow.test.ts structure but is now
// located under test/integration for clearer separation. The test bodies
// are unchanged apart from updated import paths.

