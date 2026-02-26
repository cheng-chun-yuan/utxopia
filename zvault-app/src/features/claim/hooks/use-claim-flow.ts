"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  parseClaimUrl,
  encodeClaimLink,
  decodeClaimLink,
  deriveNote,
  createNote,
  initPoseidon,
  initProver,
  generateJoinSplitProof,
  proofToBytes,
  babyJubMul,
  BABYJUB_BASE8,
  fetchCommitmentTree,
  getCommitmentIndex,
  computeUnifiedCommitmentSync,
  bytesToBigint,
  bytesToHex,
  hexToBytes,
  DEVNET_CONFIG,
  BN254_FIELD_PRIME,
  type JoinSplitProofInputs,
} from "@zvault/sdk";
import {
  ZBTC_MINT_ADDRESS,
  TOKEN_2022_PROGRAM_ID,
  ZVAULT_PROGRAM_ID,
} from "@/lib/solana/instructions";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useFlowState } from "@/features/shared/hooks";
import type {
  ClaimStep,
  ClaimProgress,
  VerifyResult,
  ClaimResult,
  SplitResult,
} from "../types";

/** ZBTC token ID used in Poseidon commitment */
const ZBTC_TOKEN_ID = BigInt(0x7a627463);

export function useClaimFlow(initialNote?: string) {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();

  const {
    step,
    setStep,
    error,
    setError,
    reset: resetFlowState,
  } = useFlowState<ClaimStep>("input");

  const [claimProgress, setClaimProgress] = useState<ClaimProgress>("idle");
  const [proverReady, setProverReady] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Form state
  const [secretPhrase, setSecretPhrase] = useState(initialNote || "");

  // Results
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [claimResult, setClaimResult] = useState<ClaimResult | null>(null);

  // Split state
  const [splitResult, setSplitResult] = useState<SplitResult | null>(null);
  const [splitLoading, setSplitLoading] = useState(false);

  // Initialize prover on mount
  useEffect(() => {
    setMounted(true);
    initProver()
      .then(() => {
        setProverReady(true);
        console.log("[Claim] Prover initialized");
      })
      .catch((err) => {
        console.warn("[Claim] Prover initialization failed:", err);
      });
  }, []);

  // Parse claim link from text
  const parseClaimLink = useCallback(
    (text: string): boolean => {
      if (text.includes("?note=") || text.includes("&note=")) {
        const match = text.match(/[?&]note=([^&\s]+)/);
        if (match) {
          const decoded = decodeClaimLink(match[1]);
          if (decoded && typeof decoded === "string") {
            setSecretPhrase(decoded);
            setError(null);
            return true;
          }
        }
      }

      if (text.includes("?n=") && text.includes("&s=")) {
        setError("Legacy claim link format not supported.");
        return false;
      }

      const decoded = decodeClaimLink(text.trim());
      if (decoded && typeof decoded === "string") {
        setSecretPhrase(decoded);
        setError(null);
        return true;
      }

      if (text.trim().length >= 8) {
        setSecretPhrase(text.trim());
        setError(null);
        return true;
      }

      return false;
    },
    [setError]
  );

  // Paste from clipboard
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!parseClaimLink(text)) {
        setError("Invalid claim link format");
      }
    } catch {
      setError("Failed to read clipboard");
    }
  }, [parseClaimLink, setError]);

  // Verify claim
  const verify = useCallback(async () => {
    if (secretPhrase.trim().length < 8) {
      setError("Please enter your secret phrase (at least 8 characters)");
      return;
    }

    setError(null);
    setStep("verifying");

    try {
      const note = deriveNote(secretPhrase.trim(), 0, BigInt(0));
      const privKey = note.nullifier;
      const pubKeyPoint = babyJubMul(privKey, BABYJUB_BASE8);
      const pubKeyX = pubKeyPoint.x;

      const nullifierHash = note.nullifierHash ?? 0n;
      const nullifierHashHex = nullifierHash.toString(16).padStart(64, "0");

      // Find commitment in index
      const commitmentIndex = getCommitmentIndex();
      let foundAmount: number | null = null;

      const tryAmounts = [10000, 100000, 50000, 25000, 1000000];
      for (const amt of tryAmounts) {
        const testCommitment = computeUnifiedCommitmentSync(pubKeyX, BigInt(amt));
        const testHex = testCommitment.toString(16).padStart(64, "0");
        const entry = commitmentIndex.getCommitment(testHex);
        if (entry) {
          foundAmount = amt;
          break;
        }
      }

      if (foundAmount === null) {
        throw new Error(
          "Commitment not found. Please ensure your deposit has been confirmed on-chain."
        );
      }

      const commitment = computeUnifiedCommitmentSync(pubKeyX, BigInt(foundAmount));
      const commitmentHex = commitment.toString(16).padStart(64, "0");

      setVerifyResult({
        commitment: commitmentHex,
        nullifierHash: nullifierHashHex,
        amountSats: foundAmount,
      });
      setStep("input");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify claim");
      setStep("error");
    }
  }, [secretPhrase, setError, setStep]);

  // Claim via JoinSplit relay
  const claim = useCallback(async () => {
    if (secretPhrase.trim().length < 8) {
      setError("Please enter your secret phrase (at least 8 characters)");
      return;
    }
    if (!connected || !publicKey) {
      setError("Please connect your Solana wallet");
      return;
    }

    setError(null);
    setStep("claiming");
    setClaimProgress("generating_proof");

    try {
      const note = deriveNote(secretPhrase.trim(), 0, BigInt(0));
      const privKey = note.nullifier;
      const pubKeyPoint = babyJubMul(privKey, BABYJUB_BASE8);
      const pubKeyX = pubKeyPoint.x;

      if (!verifyResult?.amountSats) {
        throw new Error("Please verify your claim first.");
      }

      const commitmentIndex = getCommitmentIndex();
      const amountSats = verifyResult.amountSats;
      let leafIndexBigint = 0n;
      let merkleRoot = 0n;
      let merkleSiblings: bigint[] = Array(16).fill(0n);
      let merkleIndices: number[] = Array(16).fill(0);

      // Fetch commitment tree state
      try {
        const treeState = await fetchCommitmentTree(
          {
            getAccountInfo: async (pk: unknown) => {
              const info = await connection.getAccountInfo(new PublicKey(pk as string));
              return info ? { data: new Uint8Array(info.data) } : null;
            },
          },
          DEVNET_CONFIG.commitmentTreePda
        );
        if (treeState) {
          merkleRoot = bytesToBigint(treeState.currentRoot);
        }
      } catch (fetchErr) {
        console.warn("[Claim] Could not fetch commitment tree:", fetchErr);
      }

      // Look up commitment in local index
      const commitment = computeUnifiedCommitmentSync(pubKeyX, BigInt(amountSats));
      const commitmentHex = commitment.toString(16).padStart(64, "0");
      const indexEntry = commitmentIndex.getCommitment(commitmentHex);

      if (indexEntry) {
        leafIndexBigint = indexEntry.index;
        const proof = commitmentIndex.getMerkleProof(commitment);
        if (proof) {
          merkleSiblings = proof.siblings;
          merkleIndices = proof.indices;
          merkleRoot = proof.root;
        }
      }

      const leafIndex = Number(leafIndexBigint);

      if (!proverReady) {
        throw new Error("Prover not ready. Please wait for initialization.");
      }

      // Generate JoinSplit(1,1) proof: 1 input (deposit) → 1 output (claimed note)
      // The output NPK is derived for the claimer
      const outputNpk = pubKeyX; // Same key for self-claim
      const nullifierHash = note.nullifierHash ?? 0n;

      // Compute bound params hash (hash of all public params bound to the proof)
      // For a 1x1 JoinSplit, this binds the output commitment
      const outputCommitment = computeUnifiedCommitmentSync(outputNpk, BigInt(amountSats));

      const joinsplitInputs: JoinSplitProofInputs = {
        nInputs: 1,
        nOutputs: 1,
        merkleRoot,
        boundParamsHash: 0n, // Computed by circuit
        token: ZBTC_TOKEN_ID,
        publicKey: [pubKeyPoint.x, pubKeyPoint.y],
        signature: [0n, 0n, 0n], // EdDSA-Poseidon signature (computed during proof gen)
        nullifyingKey: note.nullifier,
        inputs: [
          {
            random: note.secret ?? 0n,
            value: BigInt(amountSats),
            leafIndex: leafIndexBigint,
            merkleProof: { siblings: merkleSiblings, indices: merkleIndices },
          },
        ],
        outputs: [{ npk: outputNpk, value: BigInt(amountSats) }],
      };

      const proofData = await generateJoinSplitProof(joinsplitInputs);
      const proofBytes = proofToBytes(proofData);

      setClaimProgress("relaying");

      // Submit via relay API
      const nullifierBytes = new Uint8Array(32);
      const nhHex = nullifierHash.toString(16).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        nullifierBytes[i] = parseInt(nhHex.slice(i * 2, i * 2 + 2), 16);
      }

      const merkleRootBytes = new Uint8Array(32);
      const mrHex = merkleRoot.toString(16).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        merkleRootBytes[i] = parseInt(mrHex.slice(i * 2, i * 2 + 2), 16);
      }

      const outputCommitmentBytes = new Uint8Array(32);
      const ocHex = outputCommitment.toString(16).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        outputCommitmentBytes[i] = parseInt(ocHex.slice(i * 2, i * 2 + 2), 16);
      }

      // Stealth data: ephemeral pub (32 bytes) + encrypted amount (8 bytes)
      const stealthDataEntry = new Uint8Array(40);
      // For self-claim, ephemeral pub can be the pubkey X coordinate
      const ephPubHex = pubKeyX.toString(16).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        stealthDataEntry[i] = parseInt(ephPubHex.slice(i * 2, i * 2 + 2), 16);
      }
      // Encrypted amount (little-endian u64)
      const amountBigint = BigInt(amountSats);
      for (let i = 0; i < 8; i++) {
        stealthDataEntry[32 + i] = Number((amountBigint >> BigInt(i * 8)) & 0xffn);
      }

      const relayResponse = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nInputs: 1,
          nOutputs: 1,
          proof: bytesToHex(proofBytes),
          merkleRoot: bytesToHex(merkleRootBytes),
          boundParamsHash: "0".repeat(64), // TODO: compute properly
          nullifiers: [bytesToHex(nullifierBytes)],
          commitmentsOut: [bytesToHex(outputCommitmentBytes)],
          stealthData: [bytesToHex(stealthDataEntry)],
        }),
      });

      const relayResult = await relayResponse.json();

      if (!relayResult.success) {
        throw new Error(`Relay failed: ${relayResult.error}`);
      }

      setClaimProgress("complete");
      setClaimResult({
        txSignature: relayResult.signature,
        claimedAmount: amountSats,
        merkleRoot: merkleRoot.toString(16).padStart(64, "0"),
        leafIndex,
        proofStatus: "zk_verified",
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      setStep("success");
    } catch (err) {
      console.error("[Claim] Error:", err);
      setClaimProgress("idle");
      setError(err instanceof Error ? err.message : "Failed to claim tokens");
      setStep("error");
    }
  }, [
    secretPhrase,
    connected,
    publicKey,
    connection,
    verifyResult,
    proverReady,
    setError,
    setStep,
  ]);

  // Split claim
  const split = useCallback(
    async (sendAmountSats: number) => {
      if (!claimResult?.claimedAmount) return;

      if (sendAmountSats <= 0) {
        setError("Please enter a valid amount to send");
        return;
      }
      if (sendAmountSats >= claimResult.claimedAmount) {
        setError("Send amount must be less than total claimed amount");
        return;
      }

      setSplitLoading(true);
      setError(null);

      try {
        await initPoseidon();

        const keepAmountSats = claimResult.claimedAmount - sendAmountSats;
        const keepNote = createNote(BigInt(keepAmountSats));
        const sendNote = createNote(BigInt(sendAmountSats));

        const keepLink = encodeClaimLink(
          keepNote.nullifier.toString(),
          keepNote.secret.toString()
        );
        const sendLink = encodeClaimLink(
          sendNote.nullifier.toString(),
          sendNote.secret.toString()
        );

        setSplitResult({
          keepLink,
          keepAmount: keepAmountSats,
          sendLink,
          sendAmount: sendAmountSats,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to split notes");
      } finally {
        setSplitLoading(false);
      }
    },
    [claimResult, setError]
  );

  // Reset everything
  const reset = useCallback(() => {
    resetFlowState();
    setClaimProgress("idle");
    setSecretPhrase("");
    setVerifyResult(null);
    setClaimResult(null);
    setSplitResult(null);
  }, [resetFlowState]);

  // Get claim link URL
  const getClaimLinkUrl = useCallback(() => {
    if (secretPhrase.trim().length < 8) return null;
    return `${typeof window !== "undefined" ? window.location.origin : ""}/claim?note=${encodeURIComponent(secretPhrase.trim())}`;
  }, [secretPhrase]);

  return {
    step,
    claimProgress,
    error,
    mounted,
    proverReady,
    secretPhrase,
    verifyResult,
    claimResult,
    splitResult,
    splitLoading,
    connected,
    publicKey,

    setSecretPhrase,
    parseClaimLink,
    pasteFromClipboard,
    verify,
    claim,
    split,
    reset,
    getClaimLinkUrl,
  };
}
