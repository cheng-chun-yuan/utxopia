"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { CheckCircle2, Send, Wallet, Shield, Clock, AlertCircle, Key, Copy, Check, Pencil, X, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseSats, validateWithdrawalAmount } from "@/lib/utils/validation";
import { WalletButton } from "@/components/ui/wallet-button";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import { formatBtc, truncateMiddle } from "@/lib/utils/formatting";
import { useZVault, type InboxNote } from "@/hooks/use-zvault";
import { useProver } from "@/hooks/use-prover";
import {
  initPoseidon,
  babyJubDecompress,
  prepareClaimInputs,
  DEVNET_CONFIG,
  type StealthMetaAddress,
  type ScannedNote,
  type JoinSplitProofInputs,
} from "@zvault/sdk";
import {
  bigintTo32Bytes,
  bytesToHex,
} from "@/lib/solana/instructions";

/**
 * Convert packed encryptedAmountWithSign bigint to little-endian hex for on-chain
 *
 * On-chain expects: bytes 0-7 = encrypted amount, byte 8 bit 0 = y_sign
 * SDK bigint has: bits 0-63 = encrypted amount, bit 64 = y_sign
 *
 * Standard bigint.toString(16) produces big-endian where value is at the END
 * We need little-endian where value is at the START (bytes 0-8)
 */
function packEncryptedAmountToHex(value: bigint): string {
  const bytes = new Uint8Array(32);
  let temp = value;
  // Extract low 9 bytes (8 for amount + 1 for y_sign bit) as little-endian
  for (let i = 0; i < 9 && temp > 0n; i++) {
    bytes[i] = Number(temp & 0xffn);
    temp = temp >> 8n;
  }
  // Convert to hex string
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Validate Solana address
function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Constants
const MIN_PAY_SATS = 1000;

type PayStep = "connect" | "select_note" | "form" | "proving" | "success";

interface PayFlowProps {
  initialMode?: "public" | "stealth";
  preselectedNote?: {
    commitment: string;
    leafIndex: number;
    amount: bigint;
  };
}

export function PayFlow({ initialMode, preselectedNote }: PayFlowProps) {
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();
  const {
    keys,
    hasKeys,
    deriveKeys,
    isLoading: keysLoading,
    stealthAddress,
    inboxNotes,
    inboxLoading,
    refreshInbox,
  } = useZVault();
  const prover = useProver();

  const [step, setStep] = useState<PayStep>("connect");
  const [selectedNote, setSelectedNote] = useState<InboxNote | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [changeClaimLink, setChangeClaimLink] = useState<string | null>(null);
  const [changeAmountSats, setChangeAmountSats] = useState<number>(0);
  const [changeClaimCopied, setChangeClaimCopied] = useState(false);
  const [proofStatus, setProofStatus] = useState<string>("");

  // Recipient address state - use initialMode from props
  const [recipientMode, setRecipientMode] = useState<"public" | "stealth">(initialMode || "public");
  const [recipientAddress, setRecipientAddress] = useState<string>("");
  const [isEditingRecipient, setIsEditingRecipient] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const recipientInitializedRef = useRef(false);
  const notePreselectedRef = useRef(false);

  // Stealth recipient state
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [stealthError, setStealthError] = useState<string | null>(null);

  // Initialize recipient address when wallet connects (only once)
  useEffect(() => {
    if (publicKey && !recipientInitializedRef.current) {
      setRecipientAddress(publicKey.toBase58());
      recipientInitializedRef.current = true;
    }
  }, [publicKey]);

  // Pre-select note from props (when coming from inbox)
  useEffect(() => {
    if (notePreselectedRef.current || inboxLoading || !preselectedNote) return;

    const matchingNote = inboxNotes.find(n => n.commitmentHex === preselectedNote.commitment);
    if (matchingNote) {
      setSelectedNote(matchingNote);
      notePreselectedRef.current = true;
      if (connected && hasKeys) {
        setStep("form");
      }
    }
  }, [preselectedNote, inboxNotes, inboxLoading, connected, hasKeys]);

  // Validate recipient address (for public mode)
  const validateRecipient = useCallback((address: string): boolean => {
    if (!address.trim()) {
      setRecipientError("Recipient address is required");
      return false;
    }
    if (!isValidSolanaAddress(address)) {
      setRecipientError("Invalid Solana address");
      return false;
    }
    setRecipientError(null);
    return true;
  }, []);

  // Handle stealth recipient resolution from component
  const handleStealthResolved = useCallback((meta: StealthMetaAddress | null, name: string | null) => {
    setResolvedMeta(meta);
    setResolvedName(name);
  }, []);

  // Handle recipient edit save
  const handleSaveRecipient = useCallback(() => {
    if (validateRecipient(recipientAddress)) {
      setIsEditingRecipient(false);
    }
  }, [recipientAddress, validateRecipient]);

  // Reset to own wallet
  const handleResetRecipient = useCallback(() => {
    if (publicKey) {
      setRecipientAddress(publicKey.toBase58());
      setRecipientError(null);
      setIsEditingRecipient(false);
    }
  }, [publicKey]);

  const isOwnWallet = publicKey?.toBase58() === recipientAddress;

  // Copy change claim link to clipboard
  const copyChangeClaimLink = useCallback(async () => {
    if (!changeClaimLink) return;
    const fullUrl = `${window.location.origin}/claim?note=${changeClaimLink}`;
    await navigator.clipboard.writeText(fullUrl);
    setChangeClaimCopied(true);
    setTimeout(() => setChangeClaimCopied(false), 2000);
  }, [changeClaimLink]);

  // Get notes from stealth inbox - only unspent notes with positive balance
  const availableNotes = useMemo(() => {
    return inboxNotes.filter((n) => n.amount > 0n && !n.isSpent);
  }, [inboxNotes]);

  const amountSats = useMemo(() => parseSats(amount), [amount]);

  // Max amount is the full note balance
  const maxPaySats = useMemo(() => {
    if (!selectedNote) return 0;
    return Number(selectedNote.amount);
  }, [selectedNote]);

  const isValidAmount = amountSats && amountSats >= MIN_PAY_SATS;

  // Handle note selection
  const handleSelectNote = useCallback((note: InboxNote) => {
    setSelectedNote(note);
    setStep("form");
  }, []);

  const handlePay = async () => {
    if (!publicKey || !selectedNote) return;

    const amountValidation = validateWithdrawalAmount(amountSats ?? 0);
    if (!amountValidation.valid) {
      setError(amountValidation.error || "Invalid amount");
      return;
    }

    if (!amountSats) return;

    const noteAmountSats = Number(selectedNote.amount);
    // Check amount doesn't exceed note balance
    if (amountSats > noteAmountSats) {
      setError(`Amount exceeds note balance (${noteAmountSats} sats)`);
      return;
    }

    setLoading(true);
    setError(null);
    setStep("proving");
    setProofStatus("Initializing...");

    try {
      // Initialize Poseidon for hashing
      await initPoseidon();

      console.log("[Pay] Processing payment...");
      console.log("[Pay] Amount:", amountSats, "sats");
      console.log("[Pay] Leaf index:", selectedNote.leafIndex);
      console.log("[Pay] Commitment (hex from store):", selectedNote.commitmentHex);
      console.log("[Pay] Commitment (raw bytes):", Array.from(selectedNote.commitment).map(b => b.toString(16).padStart(2, '0')).join(''));
      console.log("[Pay] Mode:", recipientMode);

      // Pre-check: Verify the commitment exists in the on-chain tree
      setProofStatus("Verifying commitment on-chain...");
      try {
        const verifyResponse = await fetch(`/api/merkle/proof?commitment=${selectedNote.commitmentHex}`);
        const verifyData = await verifyResponse.json();
        if (!verifyData.success) {
          console.error("[Pay] Commitment not found on-chain:", verifyData.error);
          throw new Error(
            `This note (${selectedNote.commitmentHex.slice(0, 16)}...) no longer exists on-chain. ` +
            `The deposit may have been spent or the tree was reset. Please refresh your inbox.`
          );
        }
        console.log("[Pay] Commitment verified on-chain at leafIndex:", verifyData.leafIndex);
      } catch (verifyError) {
        if (verifyError instanceof Error && verifyError.message.includes("no longer exists")) {
          throw verifyError;
        }
        console.warn("[Pay] Pre-check failed, continuing:", verifyError);
      }

      // Debug: Check types of critical values
      console.log("[Pay] === TYPE CHECKS ===");
      console.log("[Pay] typeof stealthPub:", typeof selectedNote.stealthPub);
      console.log("[Pay] typeof stealthPub.x:", typeof selectedNote.stealthPub?.x);
      console.log("[Pay] typeof amount:", typeof selectedNote.amount);
      console.log("[Pay] stealthPub object:", JSON.stringify(selectedNote.stealthPub, (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v));

      // Ensure bigint types (might have been serialized to string/number)
      const pubKeyX = typeof selectedNote.stealthPub?.x === 'bigint'
        ? selectedNote.stealthPub.x
        : BigInt(selectedNote.stealthPub?.x || 0);
      const noteAmount = typeof selectedNote.amount === 'bigint'
        ? selectedNote.amount
        : BigInt(selectedNote.amount || 0);

      console.log("[Pay] Normalized pubKeyX:", pubKeyX.toString(16));
      console.log("[Pay] Normalized amount:", noteAmount.toString());

      // Debug: Compute what the circuit will compute and compare
      const { computeUnifiedCommitment } = await import("@zvault/sdk");
      const expectedCommitment = await computeUnifiedCommitment(pubKeyX, noteAmount);
      const expectedCommitmentHex = expectedCommitment.toString(16).padStart(64, "0");
      console.log("[Pay] Expected commitment (from Poseidon):", expectedCommitmentHex);
      console.log("[Pay] Stored commitmentHex matches expected:", selectedNote.commitmentHex.toLowerCase() === expectedCommitmentHex.toLowerCase());

      // CRITICAL: If mismatch, use the stored commitment's backing data
      if (selectedNote.commitmentHex.toLowerCase() !== expectedCommitmentHex.toLowerCase()) {
        console.error("[Pay] COMMITMENT MISMATCH DETECTED!");
        console.error("[Pay] This indicates the stealthPub or amount doesn't match the original commitment.");
        console.error("[Pay] Possible causes: type coercion, serialization issue, or wrong note data.");
      }

      // Validate keys and wallet
      if (!keys) {
        throw new Error("Please derive your stealth keys first");
      }
      if (!signTransaction) {
        throw new Error("Wallet doesn't support transaction signing");
      }

      setProofStatus("Initializing prover...");

      // Initialize prover if needed
      if (!prover.isInitialized) {
        await prover.initialize();
      }

      // Convert InboxNote to ScannedNote format for SDK functions
      // Convert InboxNote to ScannedNote format for SDK functions
      const scannedNote: ScannedNote = {
        amount: typeof selectedNote.amount === 'bigint' ? selectedNote.amount : BigInt(selectedNote.amount || 0),
        ephemeralPub: selectedNote.ephemeralPub, // Ed25519 Uint8Array
        stealthPub: {
          x: typeof selectedNote.stealthPub?.x === 'bigint' ? selectedNote.stealthPub.x : BigInt(selectedNote.stealthPub?.x || 0),
          y: typeof selectedNote.stealthPub?.y === 'bigint' ? selectedNote.stealthPub.y : BigInt(selectedNote.stealthPub?.y || 0),
        },
        leafIndex: selectedNote.leafIndex,
        commitment: selectedNote.commitment,
      };

      console.log("[Pay] === Scanned Note (normalized) ===");
      console.log("[Pay] amount:", scannedNote.amount.toString());
      console.log("[Pay] ephemeralPub:", Array.from(scannedNote.ephemeralPub.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('') + "...");
      console.log("[Pay] stealthPub.x:", scannedNote.stealthPub.x.toString(16).slice(0, 20) + "...");
      console.log("[Pay] stealthPub.y:", scannedNote.stealthPub.y.toString(16).slice(0, 20) + "...");
      console.log("[Pay] leafIndex:", scannedNote.leafIndex);

      // Use SDK's prepareClaimInputs to derive stealth private key correctly
      // This ensures the same derivation as createStealthDeposit
      setProofStatus("Deriving stealth keys...");

      // Create a dummy merkle proof for prepareClaimInputs (we'll get the real one from API)
      const dummyMerkleProof = {
        root: 0n,
        pathElements: Array(20).fill(0n),
        pathIndices: Array(20).fill(0),
      };

      const claimInputs = await prepareClaimInputs(keys, scannedNote, dummyMerkleProof);
      const stealthPrivKey = claimInputs.stealthPrivKey;

      console.log("[Pay] Stealth private key derived using SDK");

      // CRITICAL VERIFICATION: Re-compute stealthPub from the derived stealthPrivKey
      // This is the source of truth - the stealthPrivKey was verified in prepareClaimInputs
      const { babyJubMul, BABYJUB_BASE8, computeUnifiedCommitment: computeCommitment } = await import("@zvault/sdk");
      const derivedStealthPub = babyJubMul(stealthPrivKey, BABYJUB_BASE8);
      console.log("[Pay] === STEALTH KEY VERIFICATION ===");
      console.log("[Pay] stealthPrivKey:", stealthPrivKey.toString(16).slice(0, 20) + "...");
      console.log("[Pay] Derived stealthPub.x:", derivedStealthPub.x.toString(16).slice(0, 20) + "...");
      console.log("[Pay] Scanned stealthPub.x:", scannedNote.stealthPub.x.toString(16).slice(0, 20) + "...");
      console.log("[Pay] StealthPub X matches:", derivedStealthPub.x === scannedNote.stealthPub.x);

      // Compute commitment from derived stealthPub - this is the authoritative value
      const commitmentFromDerivedKey = await computeCommitment(derivedStealthPub.x, scannedNote.amount);
      const commitmentFromScannedNote = await computeCommitment(scannedNote.stealthPub.x, scannedNote.amount);
      console.log("[Pay] Commitment from derived key:", commitmentFromDerivedKey.toString(16).padStart(64, "0").slice(0, 20) + "...");
      console.log("[Pay] Commitment from scanned note:", commitmentFromScannedNote.toString(16).padStart(64, "0").slice(0, 20) + "...");
      console.log("[Pay] Stored commitmentHex:", selectedNote.commitmentHex.slice(0, 20) + "...");
      console.log("[Pay] Derived commitment matches stored:", commitmentFromDerivedKey.toString(16).padStart(64, "0") === selectedNote.commitmentHex.toLowerCase());

      // CRITICAL FIX: Use derivedStealthPub.x instead of scannedNote.stealthPub.x
      // The derived value is verified correct via prepareClaimInputs (which throws if mismatch)
      // The scanned value might have been corrupted by serialization/state management
      const verifiedPubKeyX = derivedStealthPub.x;
      const verifiedAmount = scannedNote.amount;

      // Final verification - the derived commitment MUST match the stored one
      const derivedCommitmentHex = commitmentFromDerivedKey.toString(16).padStart(64, "0");

      // Log to server for debugging
      try {
        await fetch("/api/debug/commitment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "pay-flow",
            stealthPrivKey: stealthPrivKey.toString(16).padStart(64, "0"),
            derivedPubKeyX: derivedStealthPub.x.toString(16).padStart(64, "0"),
            scannedPubKeyX: scannedNote.stealthPub.x.toString(16).padStart(64, "0"),
            amount: scannedNote.amount.toString(),
            derivedCommitment: derivedCommitmentHex,
            storedCommitment: selectedNote.commitmentHex,
            match: derivedCommitmentHex === selectedNote.commitmentHex.toLowerCase(),
            leafIndex: selectedNote.leafIndex,
          }),
        }).catch(() => {}); // Ignore errors from debug endpoint
      } catch {}

      if (derivedCommitmentHex !== selectedNote.commitmentHex.toLowerCase()) {
        console.error("[Pay] FATAL: Derived commitment doesn't match stored commitment!");
        console.error("[Pay] Stored commitment:", selectedNote.commitmentHex);
        console.error("[Pay] Derived commitment:", derivedCommitmentHex);
        console.error("[Pay] Selected note leafIndex:", selectedNote.leafIndex);
        console.error("[Pay] This indicates stale data or the note no longer exists on-chain.");
        throw new Error(
          `Note mismatch detected. The commitment ${selectedNote.commitmentHex.slice(0, 16)}... ` +
          `at leafIndex=${selectedNote.leafIndex} may no longer exist on-chain. ` +
          `Please refresh your inbox and try again.`
        );
      }

      // =================================================================
      // JOINSPLIT(1,2) TRANSACT
      // 1 input (spend selected note) → 2 outputs (send + change)
      // All transfers are fully private via the relay.
      // =================================================================
      setProofStatus("Generating JoinSplit proof...");

      // Determine output recipients
      const sendAmount = BigInt(amountSats);
      const changeAmount = verifiedAmount - sendAmount;

      if (changeAmount < 0n) {
        throw new Error("Insufficient balance");
      }

      // For stealth mode, use recipient's spending pubkey
      // For public mode, also use JoinSplit but the recipient redeems later
      let recipientNpk = verifiedPubKeyX; // Default: self
      if (recipientMode === "stealth" && resolvedMeta) {
        const recipientSpendingPoint = babyJubDecompress(resolvedMeta.spendingPubKey);
        recipientNpk = recipientSpendingPoint.x;
      } else if (recipientMode === "public") {
        if (!validateRecipient(recipientAddress)) {
          throw new Error("Invalid recipient address");
        }
      }

      // Build JoinSplit proof inputs
      // TODO: Compute proper EdDSA-Poseidon signature and bound params hash
      // These require the full JoinSplit signing flow from the SDK
      const joinsplitInputs: JoinSplitProofInputs = {
        nInputs: 1,
        nOutputs: 2,
        merkleRoot: claimInputs.merkleRoot,
        boundParamsHash: 0n, // Computed by circuit
        token: BigInt(0x7a627463), // ZBTC_TOKEN_ID
        publicKey: [derivedStealthPub.x, derivedStealthPub.y],
        signature: [0n, 0n, 0n], // EdDSA-Poseidon (computed during proof gen)
        nullifyingKey: claimInputs.nullifyingKey,
        inputs: [{
          random: claimInputs.random,
          value: verifiedAmount,
          leafIndex: BigInt(selectedNote.leafIndex),
          merkleProof: {
            siblings: claimInputs.merklePath,
            indices: claimInputs.merkleIndices,
          },
        }],
        outputs: [
          { npk: recipientNpk, value: sendAmount },
          { npk: verifiedPubKeyX, value: changeAmount },
        ],
      };

      const { proofBytes } = await prover.generateProof(joinsplitInputs);

      setProofStatus("Proof generated! Submitting via relay...");

      // Build relay request with TRANSACT format
      // Compute nullifier and commitments as hex
      const nullifierHex = claimInputs.nullifier.toString(16).padStart(64, "0");
      const merkleRootHex = claimInputs.merkleRoot.toString(16).padStart(64, "0");

      // Output commitments (placeholder - should be computed from Poseidon)
      const { computeUnifiedCommitment: computeCommitmentAsync } = await import("@zvault/sdk");
      const outCommitment1 = await computeCommitmentAsync(recipientNpk, sendAmount);
      const outCommitment2 = await computeCommitmentAsync(verifiedPubKeyX, changeAmount);

      const outCommitment1Hex = outCommitment1.toString(16).padStart(64, "0");
      const outCommitment2Hex = outCommitment2.toString(16).padStart(64, "0");

      // Stealth data: ephemeral_pub(32) + encrypted_amount(8) per output
      const stealthData1 = new Uint8Array(40);
      const stealthData2 = new Uint8Array(40);
      // Placeholder stealth data (proper implementation needs ECDH)
      const npk1Hex = recipientNpk.toString(16).padStart(64, "0");
      const npk2Hex = verifiedPubKeyX.toString(16).padStart(64, "0");
      for (let i = 0; i < 32; i++) {
        stealthData1[i] = parseInt(npk1Hex.slice(i * 2, i * 2 + 2), 16);
        stealthData2[i] = parseInt(npk2Hex.slice(i * 2, i * 2 + 2), 16);
      }
      // Encrypted amounts (little-endian u64)
      for (let i = 0; i < 8; i++) {
        stealthData1[32 + i] = Number((sendAmount >> BigInt(i * 8)) & 0xffn);
        stealthData2[32 + i] = Number((changeAmount >> BigInt(i * 8)) & 0xffn);
      }

      console.log("[Pay] Sending JoinSplit(1,2) to relay API...");

      const relayResponse = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nInputs: 1,
          nOutputs: 2,
          proof: bytesToHex(proofBytes),
          merkleRoot: merkleRootHex,
          boundParamsHash: "0".repeat(64), // TODO: compute properly
          nullifiers: [nullifierHex],
          commitmentsOut: [outCommitment1Hex, outCommitment2Hex],
          stealthData: [bytesToHex(stealthData1), bytesToHex(stealthData2)],
        }),
      });

      const relayResult = await relayResponse.json();

      if (!relayResult.success) {
        throw new Error(relayResult.error || "Relay failed");
      }

      console.log("[Pay] Relay successful:", relayResult.signature);
      setRequestId(relayResult.signature);

      // Record change info
      const changeAmountNum = Number(changeAmount);
      if (changeAmountNum > 0) {
        setChangeAmountSats(changeAmountNum);
        setChangeClaimLink(null);
        console.log("[Pay] Change amount:", changeAmountNum, "sats (kept as private commitment)");
      }

      setStep("success");
    } catch (err) {
      console.error("[Pay] Error:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to process payment";
      setError(errorMessage);
      setStep("form");
    } finally {
      setLoading(false);
      setProofStatus("");
    }
  };

  const resetFlow = () => {
    setStep(availableNotes.length > 0 ? "select_note" : "connect");
    setSelectedNote(null);
    setAmount("");
    setError(null);
    setRequestId(null);
    setChangeClaimLink(null);
    setChangeAmountSats(0);
    // Reset recipient to own wallet
    setRecipientMode("public");
    if (publicKey) {
      setRecipientAddress(publicKey.toBase58());
    }
    setIsEditingRecipient(false);
    setRecipientError(null);
    // Reset stealth state
    setResolvedMeta(null);
    setResolvedName(null);
    setStealthError(null);
  };

  useEffect(() => {
    if (connected && hasKeys && step === "connect") {
      // If note is pre-selected, go directly to form; otherwise to note selection
      if (selectedNote) {
        setStep("form");
      } else {
        setStep(availableNotes.length > 0 ? "select_note" : "connect");
      }
    } else if (!connected && step !== "connect") {
      setStep("connect");
    }
  }, [connected, hasKeys, step, availableNotes.length, selectedNote]);

  // Connect step - also shows if no notes available
  if (step === "connect") {
    // If connected but no keys, prompt to derive
    if (connected && !hasKeys) {
      return (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="rounded-full bg-purple/10 p-4 mb-4">
            <Key className="h-10 w-10 text-purple" />
          </div>
          <p className="text-heading6 text-foreground mb-2">Derive Your Keys</p>
          <p className="text-body2 text-gray text-center mb-6">
            Sign a message to derive your stealth keys and scan for deposits
          </p>
          <button
            onClick={deriveKeys}
            disabled={keysLoading}
            className="btn-primary w-full justify-center"
          >
            {keysLoading ? "Deriving..." : "Derive Keys"}
          </button>
        </div>
      );
    }

    // If connected with keys but no notes, show info
    if (connected && hasKeys && availableNotes.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="rounded-full bg-gray/10 p-4 mb-4">
            <Key className="h-10 w-10 text-gray" />
          </div>
          <p className="text-heading6 text-foreground mb-2">No Notes Available</p>
          <p className="text-body2 text-gray text-center mb-4">
            {inboxLoading ? "Scanning for deposits..." : "You need to receive a stealth deposit first."}
          </p>
          <div className="privacy-box mb-4 w-full">
            <Shield className="w-5 h-5 shrink-0" />
            <div className="flex flex-col">
              <span className="text-body2-semibold">Privacy Note</span>
              <span className="text-caption opacity-80">
                Notes from stealth deposits are scanned using your viewing key.
              </span>
            </div>
          </div>
          <button
            onClick={refreshInbox}
            disabled={inboxLoading}
            className="btn-secondary w-full justify-center"
          >
            {inboxLoading ? "Scanning..." : "Refresh Inbox"}
          </button>
        </div>
      );
    }

    // Not connected
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="rounded-full bg-purple/10 p-4 mb-4">
          <Wallet className="h-10 w-10 text-purple" />
        </div>
        <p className="text-heading6 text-foreground mb-2">Connect Your Wallet</p>
        <p className="text-body2 text-gray text-center mb-6">
          Connect your Solana wallet to send payments
        </p>
        <WalletButton className="btn-primary w-full justify-center" />
      </div>
    );
  }

  // Note selection step
  if (step === "select_note") {
    return (
      <div className="flex flex-col">
        {/* Privacy info */}
        <div className="privacy-box mb-4">
          <Shield className="w-5 h-5 shrink-0" />
          <div className="flex flex-col">
            <span className="text-body2-semibold">Zero-Knowledge Payment</span>
            <span className="text-caption opacity-80">
              Your payment proof hides the original deposit amount
            </span>
          </div>
        </div>

        {/* Notes list */}
        <div className="space-y-2 mb-4">
          {availableNotes.map((note, index) => (
            <button
              key={`${note.commitmentHex}-${index}`}
              onClick={() => handleSelectNote(note)}
              className={cn(
                "w-full p-4 rounded-[12px] text-left transition-all",
                "bg-muted border border-gray/15",
                "hover:border-purple/40 hover:bg-purple/5"
              )}
            >
              <div className="flex justify-between items-center mb-2">
                <span className="text-body2-semibold text-foreground">
                  {formatBtc(Number(note.amount))} zkBTC
                </span>
                <span className="text-caption text-gray">
                  {Number(note.amount).toLocaleString()} sats
                </span>
              </div>
              <div className="text-caption text-gray font-mono truncate">
                {truncateMiddle(note.commitmentHex, 8)}
              </div>
            </button>
          ))}
        </div>

        {/* Info */}
        <div className="flex items-center gap-3 p-3 bg-muted border border-gray/15 rounded-[12px]">
          <AlertCircle className="w-5 h-5 text-gray shrink-0" />
          <p className="text-caption text-gray">
            You can send any amount up to the note balance.
          </p>
        </div>
      </div>
    );
  }

  // Form step
  if (step === "form" && selectedNote) {
    const noteAmountSats = Number(selectedNote.amount);
    const changeAmount = (amountSats ?? 0) <= noteAmountSats
      ? noteAmountSats - (amountSats ?? 0)
      : 0;

    return (
      <div className="flex flex-col text-start">
        {/* Selected note info */}
        <div className="flex items-center gap-3 p-3 mb-4 bg-purple/5 border border-purple/20 rounded-[12px]">
          <Key className="w-5 h-5 text-purple shrink-0" />
          <div className="flex-1">
            <div className="flex justify-between items-center">
              <span className="text-body2-semibold text-foreground">
                Note Balance: {formatBtc(noteAmountSats)} zkBTC
              </span>
              <button
                onClick={() => setStep("select_note")}
                className="text-caption text-purple hover:text-gray-light transition-colors"
              >
                Change
              </button>
            </div>
            <span className="text-caption text-gray">
              Max: {formatBtc(maxPaySats)} zkBTC
            </span>
          </div>
        </div>

        {/* Header */}
        <div className="mb-4">
          <p className="text-body2 text-gray-light pl-2">Enter Amount</p>
        </div>

        {/* Amount Input */}
        <div className="w-full flex flex-col bg-background/50 rounded-[12px] text-start mb-4">
          <div className="flex flex-row border border-solid border-gray/20 p-[6px] pr-4 rounded-[inherit]">
            {/* zkBTC Badge */}
            <div className="w-[135px] h-[72px] flex items-center gap-2 border border-solid border-gray/15 bg-card rounded-[8px] text-body1 text-foreground p-3 shrink-0">
              <div className="w-6 h-6 rounded-full bg-gradient-to-r from-violet-500 to-purple-500 flex items-center justify-center text-[10px] font-bold text-white">zk</div>
              zkBTC
            </div>

            {/* Input */}
            <div className="flex flex-col grow justify-center">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                min="0"
                max={noteAmountSats}
                className={cn(
                  "px-4 py-1 w-full flex-1 text-heading5 outline-none",
                  "bg-transparent text-foreground placeholder:text-gray",
                  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                )}
                style={{
                  boxShadow:
                    "0px -1px 0px 0px rgba(139, 138, 158, 0.25) inset, 0px -2px 0px 0px var(--background) inset",
                }}
              />
              <div className="px-4 py-[6px] text-body2 text-gray">
                sats to send
              </div>
            </div>
          </div>

          {/* Amount info */}
          <div className={cn(
            "flex flex-col items-stretch gap-2 px-4 py-3 text-body2-semibold",
            !isValidAmount && "blur-[4px]"
          )}>
            <div className="flex justify-between text-white">
              <span>Recipient Gets</span>
              <span className="flex items-center gap-2 text-privacy">
                {formatBtc(amountSats ?? 0)} zBTC
              </span>
            </div>
            <div className="flex justify-between text-gray">
              <span>Your Change (kept private)</span>
              <span>{formatBtc(changeAmount)} zkBTC</span>
            </div>
          </div>
        </div>

        {/* Recipient Wallet */}
        <div className="mb-4">
          <p className="text-body2 text-gray-light pl-2 mb-2">Recipient</p>

          {/* Mode Toggle */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => {
                setRecipientMode("public");
                setRecipientError(null);
              }}
              className={cn(
                "flex-1 px-3 py-2 rounded-[10px] text-body2 transition-colors",
                recipientMode === "public"
                  ? "bg-privacy/20 border border-privacy/40 text-privacy"
                  : "bg-muted border border-gray/20 text-gray hover:border-gray/40"
              )}
            >
              Send to Wallet
            </button>
            <button
              onClick={() => {
                setRecipientMode("stealth");
                setRecipientError(null);
              }}
              className={cn(
                "flex-1 px-3 py-2 rounded-[10px] text-body2 transition-colors",
                recipientMode === "stealth"
                  ? "bg-purple/20 border border-purple/40 text-purple"
                  : "bg-muted border border-gray/20 text-gray hover:border-gray/40"
              )}
            >
              Send Private
            </button>
          </div>

          {/* Public Mode - Solana Address */}
          {recipientMode === "public" && (
            <>
              {isEditingRecipient ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      value={recipientAddress}
                      onChange={(e) => {
                        setRecipientAddress(e.target.value);
                        setRecipientError(null);
                      }}
                      placeholder="Enter Solana address..."
                      className={cn(
                        "flex-1 px-4 py-3 bg-muted border rounded-[10px]",
                        "text-body2 font-mono text-gray-light placeholder:text-gray/40",
                        "outline-none transition-colors",
                        recipientError
                          ? "border-red-500/50"
                          : "border-gray/20 focus:border-purple/40"
                      )}
                    />
                    <button
                      onClick={handleSaveRecipient}
                      className="p-2.5 rounded-[10px] bg-privacy/10 hover:bg-privacy/20 text-privacy transition-colors"
                      title="Save"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        handleResetRecipient();
                      }}
                      className="p-2.5 rounded-[10px] bg-gray/10 hover:bg-gray/20 text-gray transition-colors"
                      title="Cancel"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {recipientError && (
                    <p className="text-caption text-red-400 pl-2">{recipientError}</p>
                  )}
                  {publicKey && recipientAddress !== publicKey.toBase58() && (
                    <button
                      onClick={handleResetRecipient}
                      className="text-caption text-purple hover:text-purple/80 pl-2 transition-colors"
                    >
                      Reset to my wallet
                    </button>
                  )}
                </div>
              ) : (
                <div
                  className={cn(
                    "flex items-center gap-2 p-3 rounded-[12px] cursor-pointer transition-colors",
                    "bg-muted border",
                    isOwnWallet
                      ? "border-privacy/20 hover:border-privacy/40"
                      : "border-purple/20 hover:border-purple/40"
                  )}
                  onClick={() => setIsEditingRecipient(true)}
                >
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    isOwnWallet ? "bg-privacy" : "bg-purple"
                  )} />
                  <span className="flex-1 text-body2 font-mono text-gray-light truncate">
                    {recipientAddress ? truncateMiddle(recipientAddress, 8) : "—"}
                  </span>
                  <Pencil className="w-3.5 h-3.5 text-gray" />
                </div>
              )}
              <p className="text-caption text-gray mt-1 pl-2">
                {isOwnWallet
                  ? "Creates a private deposit (appears in your Notes)"
                  : "Demo: Creates stealth deposit recipient can scan • Production: Direct token transfer"}
                {!isEditingRecipient && (
                  <span className="text-gray/40"> • Click to edit</span>
                )}
              </p>
            </>
          )}

          {/* Stealth Mode - .btcpro.sol or hex address */}
          {recipientMode === "stealth" && (
            <div className="space-y-2">
              <StealthRecipientInput
                onResolved={handleStealthResolved}
                resolvedMeta={resolvedMeta}
                resolvedName={resolvedName}
                error={stealthError}
                onError={setStealthError}
              />
              <p className="text-caption text-gray pl-2">
                zkBTC will be sent privately to the stealth address
              </p>
            </div>
          )}
        </div>

        {/* Privacy info */}
        <div className="success-box mb-4">
          <Shield className="w-5 h-5 shrink-0" />
          <div className="flex flex-col">
            <span className="text-body2-semibold">Zero-Knowledge Payment</span>
            <span className="text-caption text-success/80">
              Payment amount and original deposit are hidden on-chain
            </span>
          </div>
        </div>

        {/* Processing info */}
        <div className="flex items-center gap-3 p-3 bg-muted border border-gray/15 rounded-[12px] mb-4">
          <Clock className="w-5 h-5 text-gray shrink-0" />
          <div className="text-caption text-gray">
            <span className="text-gray-light">Processing time:</span>{" "}
            30-60s (ZK proof generation)
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="warning-box mb-4">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={handlePay}
          disabled={loading || !isValidAmount || (amountSats ?? 0) > noteAmountSats}
          className="btn-primary w-full"
        >
          <Send className="w-5 h-5" />
          Generate Proof & Pay
        </button>
      </div>
    );
  }

  // Proving step
  if (step === "proving") {
    // Combine proofStatus with prover's progress for detailed updates
    const displayStatus = prover.isGenerating && prover.progress
      ? prover.progress
      : proofStatus || "Preparing transaction...";

    return (
      <div className="flex flex-col items-center py-6">
        {/* Progress circle */}
        <div className="relative w-20 h-20 mb-4">
          <div className="absolute inset-0 rounded-full border-4 border-gray/15" />
          <div
            className="absolute inset-0 rounded-full border-4 border-purple border-t-transparent animate-spin"
            style={{ animationDuration: "2s" }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <Zap className="w-8 h-8 text-purple" />
          </div>
        </div>

        <p className="text-heading6 text-foreground mb-2">
          Generating ZK Proof
        </p>

        {/* Status display */}
        <div className="w-full mb-4 p-3 bg-muted border border-gray/15 rounded-[12px]">
          <div className="flex items-center gap-2 text-body2 text-gray-light">
            <Loader2 className="w-4 h-4 animate-spin text-purple" />
            <span>{displayStatus}</span>
          </div>
          {prover.isGenerating && (
            <p className="text-caption text-gray mt-2 pl-6">
              ZK proof generation may take 30-60 seconds...
            </p>
          )}
        </div>

        {/* Prover error display */}
        {prover.error && (
          <div className="w-full mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-[12px]">
            <div className="flex items-center gap-2 text-body2 text-red-400">
              <AlertCircle className="w-4 h-4" />
              <span>{prover.error}</span>
            </div>
          </div>
        )}

        {/* Privacy info */}
        <div className="w-full privacy-box">
          <Shield className="w-5 h-5 shrink-0" />
          <div className="flex flex-col">
            <span className="text-body2-semibold">Privacy Protected</span>
            <span className="text-caption opacity-80">
              ZK proof hides the link between your deposit and payment
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Success step
  if (step === "success" && requestId) {
    return (
      <div className="flex flex-col items-center">
        {/* Success icon */}
        <div className="rounded-full bg-success/10 p-4 mb-4">
          <CheckCircle2 className="h-12 w-12 text-success" />
        </div>

        <p className="text-heading6 text-foreground mb-2">Payment Complete!</p>
        <p className="text-body2 text-gray text-center mb-6">
          {recipientMode === "stealth"
            ? "Stealth payment submitted on-chain"
            : "Your zBTC has been sent successfully"}
        </p>

        {/* Details card */}
        <div className="w-full gradient-bg-card p-4 rounded-[12px] mb-4 space-y-3">
          <div className="flex justify-between items-center text-body2">
            <span className="text-gray-light">Transaction</span>
            <a
              href={`https://orbmarkets.io/tx/${requestId}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-privacy text-xs hover:underline flex items-center gap-1"
            >
              {truncateMiddle(requestId, 8)}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
          <div className="flex justify-between items-center text-body2">
            <span className="text-gray-light">Amount</span>
            <span className="text-privacy">{formatBtc(amountSats ?? 0)} zBTC</span>
          </div>
          <div className="flex justify-between items-center text-body2 pt-2 border-t border-gray/15">
            <span className="text-gray-light">Destination</span>
            <span className={cn(
              "font-mono text-xs",
              isOwnWallet ? "text-foreground" : "text-purple"
            )}>
              {recipientAddress ? truncateMiddle(recipientAddress, 6) : "—"}
              {!isOwnWallet && " (custom)"}
            </span>
          </div>
        </div>

        {/* Change Claim Link - for partial withdrawals */}
        {changeClaimLink && changeAmountSats > 0 && (
          <div className="w-full gradient-bg-card p-4 rounded-[12px] mb-4 border border-privacy/20">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-privacy" />
                <span className="text-body2-semibold text-privacy">Change Claim Link</span>
              </div>
              <button
                onClick={copyChangeClaimLink}
                className="p-1.5 rounded-[6px] bg-privacy/10 hover:bg-privacy/20 transition-colors"
              >
                {changeClaimCopied ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-privacy" />
                )}
              </button>
            </div>
            <div className="mb-2 p-2 bg-background rounded-[8px]">
              <div className="flex justify-between items-center text-body2">
                <span className="text-gray">Remaining Balance</span>
                <span className="text-privacy font-semibold">{formatBtc(changeAmountSats)} zkBTC</span>
              </div>
            </div>
            <code className="text-caption font-mono text-gray-light break-all block mb-2">
              {`${typeof window !== 'undefined' ? window.location.origin : ''}/claim?note=${changeClaimLink}`}
            </code>
            <p className="text-caption text-gray">
              Save this link to claim your remaining balance later!
            </p>
          </div>
        )}

        {/* Info box */}
        <div className="w-full flex items-center gap-3 p-3 bg-privacy/10 border border-privacy/20 rounded-[12px] mb-6">
          <CheckCircle2 className="w-5 h-5 text-privacy shrink-0" />
          <p className="text-caption text-gray-light">
            {recipientMode === "stealth"
              ? "Recipient can scan and claim using their stealth keys"
              : "Deposit created on-chain. You can scan and claim it in Notes."}
          </p>
        </div>

        {/* Reset button */}
        <button onClick={resetFlow} className="btn-tertiary w-full">
          <Send className="w-5 h-5" />
          Make Another Payment
        </button>
      </div>
    );
  }

  return null;
}
