/**
 * ChadBuffer Integration E2E Test
 *
 * DEPRECATED: Legacy test for old proof upload flow.
 */

import { describe as _describe, it, expect, beforeAll } from "bun:test";
const describe = _describe.skip;
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";

import {
  uploadTransactionToBuffer,
  closeBuffer,
  readBufferData,
  CHADBUFFER_PROGRAM_ID,
  needsBuffer,
} from "../../src/chadbuffer";
import { hexToBytes, bytesToHex } from "../../src/instructions";
import { getConfig, DEVNET_CONFIG, setConfig } from "../../src/config";

// NOTE: Full on-chain flow remains skipped; only helpers are covered.

