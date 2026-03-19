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
  deriveMasterKey,
  initPoseidon,
  eddsaGetPubKey,
  eddsaPoseidonSign,
  fetchCommitmentTree,
  getCommitmentIndex,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  computeBoundParamsHash,
  DEFAULT_BOUND_PARAMS,
  createUnshieldBoundParams,
  createStealthDepositWithKeys,
  poseidonHashSync,
  bytesToBigint,
  bytesToHex,
  getConfig,
  type StealthMetaAddress,
  type JoinSplitProofInputs,
} from "@aegis/sdk";
import {
  initProver,
  generateJoinSplitProof,
  proofToBytes,
} from "@aegis/sdk/prover/web";
import { fetchSpentNullifierPDAs, nullifierHashToPDA } from "@/lib/nullifier-utils";
import { getBackendUrl } from "@/lib/api/constants";
import {
  ZKBTC_MINT_ADDRESS,
  TOKEN_2022_PROGRAM_ID,
  AEGIS_PROGRAM_ID,
} from "@/lib/solana/instructions";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useFlowState } from "@/features/shared/hooks";
import type {
  ClaimStep,
  ClaimProgress,
  ClaimRecipientMode,
  VerifyResult,
  ClaimResult,
  SplitResult,
} from "../types";

import { getActiveTokenId } from "@/lib/token-context";

/** BN254 scalar field modulus (big-endian bytes) */
const BN254_FR_MODULUS = [
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
  0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
  0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
  0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/** Match on-chain reduce_to_field for Solana address → BN254 field element */
function reduceToFieldClaimFlow(bytes: Uint8Array): bigint {
  let isGe = true;
  for (let i = 0; i < 32; i++) {
    if (bytes[i] < BN254_FR_MODULUS[i]) { isGe = false; break; }
    if (bytes[i] > BN254_FR_MODULUS[i]) { break; }
  }
  if (!isGe) {
    return BigInt("0x" + Buffer.from(bytes).toString("hex"));
  }
  const reduced = new Uint8Array(bytes);
  reduced[0] &= 0x2F;
  return BigInt("0x" + Buffer.from(reduced).toString("hex"));
}

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

  // Recipient state
  const [recipientMode, setRecipientMode] = useState<ClaimRecipientMode>("self");
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [solanaAddress, setSolanaAddress] = useState("");

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
      if (text.includes("#note=") || text.includes("?note=") || text.includes("&note=")) {
        const match = text.match(/[#?&]note=([^&#\s]+)/);
        if (match) {
          const decoded = decodeClaimLink(match[1]);
          if (decoded && typeof decoded === "string") {
            setSecretPhrase(decoded);
            setError(null);
            return true;
          }
        }
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
      await initPoseidon();

      // Derive EdDSA seed and public key from secret phrase
      const masterKey = deriveMasterKey(secretPhrase.trim());
      const pubKeyPoint = await eddsaGetPubKey(masterKey);
      const pubKeyX = pubKeyPoint.x;

      // Also derive note for nullifyingKey and random
      const note = deriveNote(secretPhrase.trim(), 0, BigInt(0));

      // Find commitment in index by trying common amounts
      // On-chain commitment = Poseidon(npk, getActiveTokenId(), amount)
      const commitmentIndex = getCommitmentIndex();
      let foundAmount: number | null = null;
      let foundLeafIndex: bigint = 0n;

      // Iterate all stored commitments: for each, compute Poseidon(npk, token, amount)
      // and check if it matches the stored commitment hash.
      const exported = commitmentIndex.export();
      for (const [commitHex, entry] of exported.commitments) {
        const amt = BigInt(entry.amount);
        const testCommitment = computeJoinSplitCommitmentSync(pubKeyX, getActiveTokenId(), amt);
        const testHex = testCommitment.toString(16).padStart(64, "0");
        if (testHex === commitHex) {
          foundAmount = Number(amt);
          foundLeafIndex = BigInt(entry.index);
          break;
        }
      }

      if (foundAmount === null) {
        throw new Error(
          "Commitment not found. Please ensure your deposit has been confirmed on-chain."
        );
      }

      // Compute actual nullifier hash: Poseidon(nullifyingKey, leafIndex)
      const nullifierValue = computeJoinSplitNullifierSync(note.nullifier, foundLeafIndex);
      const nullifierHex = nullifierValue.toString(16).padStart(64, "0");

      // Check if nullifier already spent — fetch all PDAs, match client-side (privacy)
      // Uses backend primary with on-chain getProgramAccounts fallback
      const backendUrl = getBackendUrl();
      const spentPdas = await fetchSpentNullifierPDAs(backendUrl);
      if (spentPdas.has(nullifierHashToPDA(nullifierHex))) {
        throw new Error("This note has already been claimed.");
      }

      const commitment = computeJoinSplitCommitmentSync(pubKeyX, getActiveTokenId(), BigInt(foundAmount));
      const commitmentHex = commitment.toString(16).padStart(64, "0");

      setVerifyResult({
        commitment: commitmentHex,
        nullifierHash: nullifierHex,
        amountSats: foundAmount,
      });
      setStep("input");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify claim");
      setStep("error");
    }
  }, [secretPhrase, connection, setError, setStep]);

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
    if (recipientMode === "stealth" && !resolvedMeta) {
      setError("Please resolve a stealth recipient first");
      return;
    }
    if (recipientMode === "public" && !solanaAddress.trim()) {
      setError("Please enter a Solana address");
      return;
    }

    setError(null);
    setStep("claiming");
    setClaimProgress("generating_proof");

    try {
      // Derive EdDSA seed and keys from secret phrase
      const masterKey = deriveMasterKey(secretPhrase.trim());
      const pubKeyPoint = await eddsaGetPubKey(masterKey);
      const pubKeyX = pubKeyPoint.x;

      // Also derive note for nullifyingKey and random
      const note = deriveNote(secretPhrase.trim(), 0, BigInt(0));

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
          getConfig().commitmentTreePda
        );
        if (treeState) {
          merkleRoot = bytesToBigint(treeState.currentRoot);
        }
      } catch (fetchErr) {
        console.warn("[Claim] Could not fetch commitment tree:", fetchErr);
      }

      // Look up commitment in local index (on-chain: Poseidon(npk, token, amount))
      const commitment = computeJoinSplitCommitmentSync(pubKeyX, getActiveTokenId(), BigInt(amountSats));
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

      // Compute actual nullifier: Poseidon(nullifyingKey, leafIndex)
      const nullifierHash = computeJoinSplitNullifierSync(note.nullifier, leafIndexBigint);
      const amountBig = BigInt(amountSats);

      // Determine output NPK and stealth data based on recipient mode
      let outputNpk: bigint;
      let stealthDataEntry: Uint8Array;
      let isPublicUnshield = false;
      let boundParamsHashValue: bigint;

      if (recipientMode === "stealth" && resolvedMeta) {
        // Send to another stealth address
        const result = await createStealthDepositWithKeys(resolvedMeta, amountBig, getActiveTokenId());
        outputNpk = result.stealthPubKeyX;
        stealthDataEntry = new Uint8Array(40);
        stealthDataEntry.set(result.ephemeralPub, 0);
        stealthDataEntry.set(result.encryptedAmount, 32);
        boundParamsHashValue = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
      } else if (recipientMode === "public") {
        // Unshield to Solana address
        isPublicUnshield = true;
        const recipientPubkey = new PublicKey(solanaAddress.trim());
        const addrBytes = recipientPubkey.toBytes();
        // Match on-chain reduce_to_field: if bytes >= BN254 modulus, mask first byte
        outputNpk = reduceToFieldClaimFlow(addrBytes);
        const unshieldParams = createUnshieldBoundParams(addrBytes);
        boundParamsHashValue = computeBoundParamsHash(unshieldParams);
        // Dummy stealth data (not used for unshield)
        stealthDataEntry = new Uint8Array(40);
      } else {
        // Self-claim (default)
        outputNpk = pubKeyX;
        stealthDataEntry = new Uint8Array(40);
        const ephPubHex = pubKeyX.toString(16).padStart(64, "0");
        for (let i = 0; i < 32; i++) {
          stealthDataEntry[i] = parseInt(ephPubHex.slice(i * 2, i * 2 + 2), 16);
        }
        for (let i = 0; i < 8; i++) {
          stealthDataEntry[32 + i] = Number((amountBig >> BigInt(i * 8)) & 0xffn);
        }
        boundParamsHashValue = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
      }

      const outputCommitment = computeJoinSplitCommitmentSync(outputNpk, getActiveTokenId(), amountBig);

      // Compute EdDSA-Poseidon signature
      // msgHash = Poseidon(merkleRoot, boundParamsHash, nullifier, outputCommitment)
      const msgHash = poseidonHashSync([merkleRoot, boundParamsHashValue, nullifierHash, outputCommitment]);
      const [sigR8x, sigR8y, sigS] = await eddsaPoseidonSign(masterKey, msgHash);

      const joinsplitInputs: JoinSplitProofInputs = {
        nInputs: 1,
        nOutputs: 1,
        merkleRoot,
        boundParamsHash: boundParamsHashValue,
        token: getActiveTokenId(),
        publicKey: [pubKeyPoint.x, pubKeyPoint.y],
        signature: [sigR8x, sigR8y, sigS],
        nullifyingKey: note.nullifier,
        inputs: [
          {
            random: note.secret ?? 0n,
            value: amountBig,
            leafIndex: leafIndexBigint,
            merkleProof: { siblings: merkleSiblings, indices: merkleIndices },
          },
        ],
        outputs: [{ npk: outputNpk, value: amountBig }],
      };

      const proofData = await generateJoinSplitProof(joinsplitInputs);
      const proofBytes = proofToBytes(proofData);

      setClaimProgress("relaying");

      // Convert values to hex bytes
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

      let relayResult: { success: boolean; signature?: string; error?: string };

      if (isPublicUnshield) {
        // Public unshield: call /api/unshield
        const recipientPubkey = new PublicKey(solanaAddress.trim());
        const zkbtcMint = new PublicKey(getConfig().zkbtcMint);
        const TOKEN_2022_PID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        const recipientTokenAccount = getAssociatedTokenAddressSync(
          zkbtcMint, recipientPubkey, false, TOKEN_2022_PID
        );

        const relayResponse = await fetch("/api/unshield", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nInputs: 1,
            nOutputs: 1,
            proof: bytesToHex(proofBytes),
            merkleRoot: bytesToHex(merkleRootBytes),
            boundParamsHash: boundParamsHashValue.toString(16).padStart(64, "0"),
            nullifiers: [bytesToHex(nullifierBytes)],
            commitmentsOut: [bytesToHex(outputCommitmentBytes)],
            stealthData: [],
            unshieldAmount: amountSats.toString(),
            recipientAddress: recipientPubkey.toBase58(),
            recipientTokenAccount: recipientTokenAccount.toBase58(),
          }),
        });
        relayResult = await relayResponse.json();
      } else {
        // Private transfer (self or stealth): call /api/relay
        const relayResponse = await fetch("/api/relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nInputs: 1,
            nOutputs: 1,
            proof: bytesToHex(proofBytes),
            merkleRoot: bytesToHex(merkleRootBytes),
            boundParamsHash: boundParamsHashValue.toString(16).padStart(64, "0"),
            nullifiers: [bytesToHex(nullifierBytes)],
            commitmentsOut: [bytesToHex(outputCommitmentBytes)],
            stealthData: [bytesToHex(stealthDataEntry)],
          }),
        });
        relayResult = await relayResponse.json();
      }

      if (!relayResult.success) {
        throw new Error(`Relay failed: ${relayResult.error}`);
      }

      setClaimProgress("complete");
      setClaimResult({
        txSignature: relayResult.signature ?? "",
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
    recipientMode,
    resolvedMeta,
    solanaAddress,
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

        // Generate random seed phrases for split notes
        const randomBytes = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
        const keepSeed = `split-keep-${randomBytes(16)}`;
        const sendSeed = `split-send-${randomBytes(16)}`;

        const keepLink = encodeClaimLink(keepSeed);
        const sendLink = encodeClaimLink(sendSeed);

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
    setRecipientMode("self");
    setResolvedMeta(null);
    setSolanaAddress("");
    setVerifyResult(null);
    setClaimResult(null);
    setSplitResult(null);
  }, [resetFlowState]);

  // Get claim link URL
  const getClaimLinkUrl = useCallback(() => {
    if (secretPhrase.trim().length < 8) return null;
    return `${typeof window !== "undefined" ? window.location.origin : ""}/claim#note=${encodeURIComponent(secretPhrase.trim())}`;
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
    recipientMode,
    resolvedMeta,
    solanaAddress,

    setSecretPhrase,
    setRecipientMode,
    setResolvedMeta,
    setSolanaAddress,
    parseClaimLink,
    pasteFromClipboard,
    verify,
    claim,
    split,
    reset,
    getClaimLinkUrl,
  };
}
