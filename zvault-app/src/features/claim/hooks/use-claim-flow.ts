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
  generateClaimProof,
  proofToBytes,
  babyJubMul,
  BABYJUB_BASE8,
  deriveCommitmentTreePDA,
  fetchCommitmentTree,
  getCommitmentIndex,
  computeUnifiedCommitmentSync,
  bytesToBigint,
  hexToBytes,
  DEVNET_CONFIG,
  BN254_FIELD_PRIME,
  type ClaimInputs,
} from "@zvault/sdk";
import {
  buildClaimTransaction,
  ZBTC_MINT_ADDRESS,
  TOKEN_2022_PROGRAM_ID,
} from "@/lib/solana/instructions";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ZVAULT_PROGRAM_ID } from "@/lib/constants";
import { useFlowState } from "@/features/shared/hooks";
import type {
  ClaimStep,
  ClaimProgress,
  VerifyResult,
  ClaimResult,
  SplitResult,
} from "../types";

export function useClaimFlow(initialNote?: string) {
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();

  // Flow state
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
  const parseClaimLink = useCallback((text: string): boolean => {
    // Try to extract note parameter from URL
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

    // Legacy format not supported
    if (text.includes("?n=") && text.includes("&s=")) {
      setError("Legacy claim link format not supported.");
      return false;
    }

    // Try direct decode
    const decoded = decodeClaimLink(text.trim());
    if (decoded && typeof decoded === "string") {
      setSecretPhrase(decoded);
      setError(null);
      return true;
    }

    // Try as raw seed phrase
    if (text.trim().length >= 8) {
      setSecretPhrase(text.trim());
      setError(null);
      return true;
    }

    return false;
  }, [setError]);

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
        throw new Error("Commitment not found. Please ensure your deposit has been confirmed on-chain.");
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

  // Claim tokens
  const claim = useCallback(async () => {
    if (secretPhrase.trim().length < 8) {
      setError("Please enter your secret phrase (at least 8 characters)");
      return;
    }
    if (!connected || !publicKey) {
      setError("Please connect your Solana wallet");
      return;
    }
    if (!signTransaction) {
      setError("Wallet does not support transaction signing");
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
      let amountSats = verifyResult.amountSats;
      let leafIndexBigint = 0n;
      let merkleRoot = 0n;
      let merkleSiblings: bigint[] = Array(20).fill(0n);
      let merkleIndices: number[] = Array(20).fill(0);

      // Fetch commitment tree state
      try {
        const [commitmentTreePDA] = await deriveCommitmentTreePDA(ZVAULT_PROGRAM_ID);
        const treeState = await fetchCommitmentTree(
          {
            getAccountInfo: async (pk: unknown) => {
              const info = await connection.getAccountInfo(new PublicKey(pk as string));
              return info ? { data: new Uint8Array(info.data) } : null;
            },
          },
          commitmentTreePDA
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
        amountSats = Number(indexEntry.amount);
        leafIndexBigint = indexEntry.index;
        const proof = commitmentIndex.getMerkleProof(commitment);
        if (proof) {
          merkleSiblings = proof.siblings;
          merkleIndices = proof.indices;
          merkleRoot = proof.root;
        }
      }

      const merkleRootHex = "0x" + merkleRoot.toString(16).padStart(64, "0");
      const leafIndex = Number(leafIndexBigint);

      // Generate proof
      if (!proverReady) {
        throw new Error("Prover not ready. Please wait for initialization.");
      }

      const recipientBigint = BigInt("0x" + Buffer.from(publicKey.toBytes()).toString("hex")) % BN254_FIELD_PRIME;
      const claimInputs: ClaimInputs = {
        privKey,
        amount: BigInt(amountSats),
        leafIndex: leafIndexBigint,
        merkleRoot,
        merkleProof: { siblings: merkleSiblings, indices: merkleIndices },
        recipient: recipientBigint,
      };

      const proofData = await generateClaimProof(claimInputs);
      const proofBytes = proofToBytes(proofData);

      setClaimProgress("submitting");

      // Build transaction
      const nullifierHashHex = note.nullifierHash?.toString(16).padStart(64, "0") ?? "0".repeat(64);
      const nullifierHashBytes = new Uint8Array(Buffer.from(nullifierHashHex, "hex"));
      const merkleRootBytes = new Uint8Array(Buffer.from(merkleRootHex.slice(2), "hex"));

      const userTokenAccount = getAssociatedTokenAddressSync(ZBTC_MINT_ADDRESS, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const vkHash = hexToBytes(DEVNET_CONFIG.vkHashes.claim);

      const transaction = await buildClaimTransaction(connection, {
        nullifierHash: nullifierHashBytes,
        merkleRoot: merkleRootBytes,
        zkProof: proofBytes,
        amountSats: BigInt(amountSats),
        userPubkey: publicKey,
        userTokenAccount,
        vkHash,
      });

      setClaimProgress("relaying");

      // Sign and submit
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      const signedTx = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      setClaimProgress("confirming");

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      setClaimProgress("complete");
      setClaimResult({
        txSignature: signature,
        claimedAmount: amountSats,
        merkleRoot: merkleRootHex,
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
    signTransaction,
    connection,
    verifyResult,
    proverReady,
    setError,
    setStep,
  ]);

  // Split claim
  const split = useCallback(async (sendAmountSats: number) => {
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
  }, [claimResult, setError]);

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
    // State
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

    // Actions
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
