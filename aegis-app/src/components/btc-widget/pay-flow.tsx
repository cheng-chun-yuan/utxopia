"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, Connection } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  CheckCircle2, Send, Wallet, Shield, Clock, AlertCircle,
  Key, Copy, Check, Pencil, X, Loader2, Zap, Plus, Trash2, Bitcoin, FileText,
  Download, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseSats, validateWithdrawalAmount } from "@/lib/utils/validation";
import { WalletButton } from "@/components/ui/wallet-button";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import { BtcAddressInput } from "@/components/ui/btc-address-input";
import { formatBtc, truncateMiddle } from "@/lib/utils/formatting";
import { useAegis, type InboxNote } from "@/hooks/use-aegis";
import { useProver } from "@/hooks/use-prover";
import {
  initPoseidon,
  prepareClaimInputs,
  DEVNET_CONFIG,
  deriveMasterKey,
  eddsaGetPubKey,
  deriveKeysFromSeed,
  deriveKeysFromSeedCircuit,
  createStealthMetaAddress,
  type StealthMetaAddress,
  type ScannedNote,
  type JoinSplitProofInputs,
} from "@aegis/sdk";
import {
  bytesToHex,
  AEGIS_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ZBTC_MINT_ADDRESS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveVkRegistryPDA,
  deriveNullifierPDA,
  deriveRedemptionRequestPDA,
  deriveTransferStealthAnnouncementPDA,
  getTokenAccountAddress,
  bigintTo32Bytes,
} from "@/lib/solana/instructions";
import { scanSecretPhrase, type ScannedSecretNote } from "@/lib/claim-utils";

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
const ZBTC_TOKEN_ID = BigInt(0x7a627463);
const MAX_OUTPUTS = 12; // N+M<=14, need at least 1 input + 1 change

// BN254 scalar field modulus (big-endian bytes)
const BN254_FR_MODULUS = [
  0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
  0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
  0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
  0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/**
 * Match on-chain reduce_to_field: if bytes >= BN254 modulus, mask first byte.
 * This ensures the commitment computed off-chain matches the on-chain verification.
 */
function reduceToFieldOnChain(bytes: Uint8Array): bigint {
  // Check if bytes >= BN254_FR_MODULUS (big-endian comparison)
  let isGe = true;
  for (let i = 0; i < 32; i++) {
    if (bytes[i] < BN254_FR_MODULUS[i]) { isGe = false; break; }
    if (bytes[i] > BN254_FR_MODULUS[i]) { break; } // isGe stays true
  }
  if (!isGe) {
    return BigInt("0x" + Buffer.from(bytes).toString("hex"));
  }
  // Mask first byte to bring into field range (matches on-chain result[0] &= 0x2F)
  const reduced = new Uint8Array(bytes);
  reduced[0] &= 0x2F;
  return BigInt("0x" + Buffer.from(reduced).toString("hex"));
}

// Available circuit variants (tier-1 + tier-2 — must match files in public/circuits/groth16/)
const AVAILABLE_CIRCUITS = new Set([
  "1x1", "1x2", "2x1", "2x2",  // tier-1
  "1x3", "3x1", "2x3", "3x2", "1x4", "4x1",  // tier-2
]);

type PayStep = "connect" | "compose" | "proving" | "success";

const PAY_STEPS: { key: PayStep; label: string }[] = [
  { key: "connect", label: "Connect" },
  { key: "compose", label: "Compose" },
  { key: "proving", label: "Prove" },
  { key: "success", label: "Complete" },
];

const PROVING_SUB_STEPS = [
  { match: "Initializing", label: "Initializing" },
  { match: "Fetching", label: "Fetching Merkle proofs" },
  { match: "Deriving", label: "Deriving stealth keys" },
  { match: "Preparing", label: "Preparing outputs" },
  { match: "Signing", label: "Signing transaction" },
  { match: "Generating", label: "Generating ZK proof" },
  { match: "Submitting", label: "Submitting on-chain" },
];

function getProvingSubStepIndex(status: string): number {
  for (let i = PROVING_SUB_STEPS.length - 1; i >= 0; i--) {
    if (status.startsWith(PROVING_SUB_STEPS[i].match)) return i;
  }
  return 0;
}

function ProvingSubSteps({ status }: { status: string }) {
  const currentIdx = getProvingSubStepIndex(status);

  return (
    <div className="w-full space-y-1.5">
      {PROVING_SUB_STEPS.map((sub, i) => {
        const isComplete = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isPending = i > currentIdx;

        return (
          <div key={sub.match} className="flex items-center gap-3">
            {/* Icon */}
            <div className="w-5 h-5 flex items-center justify-center shrink-0">
              {isComplete ? (
                <CheckCircle2 className="w-4.5 h-4.5 text-success" />
              ) : isCurrent ? (
                <Loader2 className="w-4.5 h-4.5 text-purple animate-spin" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-gray/25" />
              )}
            </div>
            {/* Label */}
            <span
              className={cn(
                "text-body2 transition-colors",
                isComplete && "text-success",
                isCurrent && "text-foreground font-medium",
                isPending && "text-gray/40",
              )}
            >
              {sub.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StepIndicator({ current }: { current: PayStep }) {
  const currentIdx = PAY_STEPS.findIndex((s) => s.key === current);

  return (
    <div className="flex items-center justify-between mb-6 px-2">
      {PAY_STEPS.map((s, i) => {
        const isComplete = i < currentIdx;
        const isCurrent = i === currentIdx;

        return (
          <div key={s.key} className="flex items-center flex-1 last:flex-none">
            {/* Step circle + label */}
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold transition-all",
                  isComplete && "bg-success text-black",
                  isCurrent && "bg-purple text-white ring-2 ring-purple/30",
                  !isComplete && !isCurrent && "bg-muted text-gray border border-gray/20",
                )}
              >
                {isComplete ? (
                  <Check className="w-4 h-4" />
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium whitespace-nowrap",
                  isComplete && "text-success",
                  isCurrent && "text-purple",
                  !isComplete && !isCurrent && "text-gray",
                )}
              >
                {s.label}
              </span>
            </div>
            {/* Connector line */}
            {i < PAY_STEPS.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-[2px] mx-2 mt-[-16px] transition-all",
                  i < currentIdx ? "bg-success" : "bg-gray/20",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

type OutputMode = "stealth" | "public" | "note" | "btc";

interface OutputRow {
  id: string;
  mode: OutputMode;
  amount: string;
  secretPhrase: string;
  resolvedMeta: StealthMetaAddress | null;
  resolvedName: string | null;
  stealthError: string | null;
  solanaAddress: string;
  addressError: string | null;
  btcAddress: string | null;
  btcScriptPubKey: Uint8Array | null;
  btcAddressError: string | null;
}

function createOutputRow(mode: OutputMode = "public", defaultAddress = ""): OutputRow {
  return {
    id: crypto.randomUUID(),
    mode,
    amount: "",
    secretPhrase: "",
    resolvedMeta: null,
    resolvedName: null,
    stealthError: null,
    solanaAddress: defaultAddress,
    addressError: null,
    btcAddress: null,
    btcScriptPubKey: null,
    btcAddressError: null,
  };
}

/**
 * Auto-select smallest combination of notes that covers the target amount.
 * Greedy: sort ascending, pick until we cover it.
 */
function autoSelectNotes(notes: InboxNote[], targetSats: number): Set<string> {
  if (targetSats <= 0) return new Set();
  const sorted = [...notes].sort((a, b) => Number(a.amount) - Number(b.amount));
  const selected = new Set<string>();
  let total = 0;
  for (const note of sorted) {
    selected.add(note.id);
    total += Number(note.amount);
    if (total >= targetSats) break;
  }
  return selected;
}

interface PayFlowProps {
  initialMode?: "public" | "stealth" | "btc_withdraw";
  preselectedNote?: {
    commitment: string;
    leafIndex: number;
    amount: bigint;
  };
  initialSecretPhrase?: string;
}

export function PayFlow({ initialMode, preselectedNote, initialSecretPhrase }: PayFlowProps) {
  const { publicKey, connected, signTransaction, sendTransaction } = useWallet();
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
    publicZkbtcBalance,
    refreshPublicBalance,
  } = useAegis();
  const prover = useProver();

  const [step, setStep] = useState<PayStep>("connect");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [changeAmountSats, setChangeAmountSats] = useState<number>(0);
  const [proofStatus, setProofStatus] = useState<string>("");

  // Input notes state
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const [showNoteSelector, setShowNoteSelector] = useState(false);
  const notePreselectedRef = useRef(false);

  // Imported note from secret phrase
  const [showImportInput, setShowImportInput] = useState(!!initialSecretPhrase);
  const [importPhrase, setImportPhrase] = useState(initialSecretPhrase || "");
  const [importedNotes, setImportedNotes] = useState<ScannedSecretNote[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importAutoTriggered = useRef(false);

  // Output rows state — default first output based on initialMode
  const defaultOutputMode: OutputMode = initialMode === "btc_withdraw" ? "btc" : (initialMode === "public" ? "public" : "stealth");
  const [outputs, setOutputs] = useState<OutputRow[]>([
    createOutputRow(defaultOutputMode),
  ]);

  // Available unspent notes
  const availableNotes = useMemo(() => {
    return inboxNotes.filter((n) => n.amount > 0n && !n.isSpent);
  }, [inboxNotes]);

  // Selected notes
  const selectedNotes = useMemo(() => {
    return availableNotes.filter((n) => selectedNoteIds.has(n.id));
  }, [availableNotes, selectedNoteIds]);

  // Active unspent imported notes
  const activeImportedNotes = useMemo(() =>
    importedNotes.filter(n => !n.isSpent),
  [importedNotes]);
  const hasImportedNotes = activeImportedNotes.length > 0;

  // Total input sats (imported notes replace inbox notes when active)
  const totalInputSats = useMemo(() => {
    if (hasImportedNotes) return activeImportedNotes.reduce((sum, n) => sum + n.amount, 0);
    return selectedNotes.reduce((sum, n) => sum + Number(n.amount), 0);
  }, [selectedNotes, activeImportedNotes, hasImportedNotes]);

  // Total output sats (sum of all output amounts)
  const totalOutputSats = useMemo(() => {
    return outputs.reduce((sum, o) => {
      const sats = parseSats(o.amount);
      return sum + (sats ?? 0);
    }, 0);
  }, [outputs]);

  // Change = input - output
  const changeSats = totalInputSats - totalOutputSats;

  // Derived flags
  const hasBtcOutput = outputs.some(o => o.mode === "btc");
  const hasPublicOutput = outputs.some(o => o.mode === "public");

  // Circuit shape
  const nInputs = hasImportedNotes ? activeImportedNotes.length : selectedNotes.length;
  const nOutputs = outputs.length + (changeSats > 0 ? 1 : 0); // +1 for change

  // Initialize default recipient address when wallet connects
  const recipientInitializedRef = useRef(false);
  useEffect(() => {
    if (publicKey && !recipientInitializedRef.current) {
      setOutputs((prev) =>
        prev.map((o, i) =>
          i === 0 && !o.solanaAddress
            ? { ...o, solanaAddress: publicKey.toBase58() }
            : o
        )
      );
      recipientInitializedRef.current = true;
    }
  }, [publicKey]);

  // Pre-select note from props
  useEffect(() => {
    if (notePreselectedRef.current || inboxLoading || !preselectedNote) return;
    const matchingNote = availableNotes.find(
      (n) => n.commitmentHex === preselectedNote.commitment
    );
    if (matchingNote) {
      setSelectedNoteIds(new Set([matchingNote.id]));
      notePreselectedRef.current = true;
      if (connected && hasKeys) {
        setStep("compose");
      }
    }
  }, [preselectedNote, availableNotes, inboxLoading, connected, hasKeys]);

  // Auto-select notes when total output changes
  useEffect(() => {
    if (notePreselectedRef.current) return; // Don't auto-select if user pre-selected
    if (totalOutputSats > 0 && availableNotes.length > 0) {
      setSelectedNoteIds(autoSelectNotes(availableNotes, totalOutputSats));
    }
  }, [totalOutputSats, availableNotes]);

  // Step transitions
  useEffect(() => {
    if (connected && hasKeys && step === "connect") {
      setStep("compose");
    } else if (!connected && step !== "connect") {
      setStep("connect");
    }
  }, [connected, hasKeys, step]);

  // Auto-import note from ?note= URL param
  useEffect(() => {
    if (!initialSecretPhrase || importAutoTriggered.current || !connected || !hasKeys) return;
    importAutoTriggered.current = true;
    handleImportScan(initialSecretPhrase);
  }, [initialSecretPhrase, connected, hasKeys]);

  // Import scan handler
  const handleImportScan = useCallback(async (phrase?: string) => {
    const p = (phrase || importPhrase).trim();
    if (p.length < 8) {
      setImportError("Secret phrase must be at least 8 characters");
      return;
    }
    setImportLoading(true);
    setImportError(null);
    try {
      const results = await scanSecretPhrase(p);
      setImportedNotes(results);
      // When imported notes are active, clear inbox note selection
      setSelectedNoteIds(new Set());
      notePreselectedRef.current = true; // prevent auto-select from overriding
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to scan phrase");
    } finally {
      setImportLoading(false);
    }
  }, [importPhrase]);

  // Clear imported notes
  const clearImportedNote = useCallback(() => {
    setImportedNotes([]);
    setImportPhrase("");
    setImportError(null);
    setShowImportInput(false);
    notePreselectedRef.current = false;
  }, []);

  // Unified refresh: inbox + imported notes nullifier check
  const handleRefresh = useCallback(async () => {
    // Refresh wallet inbox
    refreshInbox();
    // Re-scan imported notes (re-fetches announcements + re-checks nullifiers)
    if (importPhrase.trim().length >= 8) {
      try {
        const results = await scanSecretPhrase(importPhrase.trim());
        setImportedNotes(results);
      } catch {
        // Keep existing imported notes on error
      }
    }
  }, [refreshInbox, importPhrase]);

  // ===== Output row handlers =====

  const updateOutput = useCallback(
    (id: string, update: Partial<OutputRow>) => {
      setOutputs((prev) =>
        prev.map((o) => (o.id === id ? { ...o, ...update } : o))
      );
    },
    []
  );

  const addOutput = useCallback(() => {
    if (outputs.length >= MAX_OUTPUTS) return;
    setOutputs((prev) => [
      ...prev,
      createOutputRow("stealth"),
    ]);
  }, [outputs.length]);

  const removeOutput = useCallback(
    (id: string) => {
      if (outputs.length <= 1) return;
      setOutputs((prev) => prev.filter((o) => o.id !== id));
    },
    [outputs.length]
  );

  // ===== Note selection handlers =====

  const toggleNoteSelection = useCallback((noteId: string) => {
    setSelectedNoteIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  }, []);

  // ===== Validation =====

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    // For public redeem, no shielded notes needed
    const hasBtcOut = outputs.some(o => o.mode === "btc");
    const canPublicRedeem = hasBtcOut && selectedNotes.length === 0 && !hasImportedNotes && publicZkbtcBalance > 0n;
    if (!canPublicRedeem && !hasImportedNotes && selectedNotes.length === 0) errors.push("Select at least one input note");
    if (outputs.length === 0) errors.push("Add at least one recipient");

    for (const o of outputs) {
      const sats = parseSats(o.amount);
      if (!sats || sats < MIN_PAY_SATS) {
        errors.push(`Each output must be at least ${MIN_PAY_SATS} sats`);
        break;
      }
    }

    if (totalOutputSats > totalInputSats) {
      errors.push("Insufficient balance: outputs exceed inputs");
    }

    // For public redeem, skip shielded balance/circuit checks
    if (canPublicRedeem) {
      // Just check that public balance covers the output
      if (totalOutputSats > Number(publicZkbtcBalance)) {
        errors.push("Insufficient public zkBTC balance");
      }
    } else {
      if (changeSats < 0) {
        errors.push("Insufficient balance");
      }

      // Check N+M constraint
      const totalIO = nInputs + nOutputs;
      if (totalIO > 14) {
        errors.push(`Too many inputs/outputs (${totalIO}/14 max)`);
      }

      // Check circuit availability (only tier-1 circuits compiled)
      if (nInputs > 0 && nOutputs > 0) {
        const circuitKey = `${nInputs}x${nOutputs}`;
        if (!AVAILABLE_CIRCUITS.has(circuitKey)) {
          errors.push(`Circuit JoinSplit(${circuitKey}) not available`);
        }
      }
    }

    // At most 1 public or btc output allowed (both go in last position)
    const publicOutputCount = outputs.filter(o => o.mode === "public").length;
    const btcOutputCount = outputs.filter(o => o.mode === "btc").length;
    if (publicOutputCount > 1) {
      errors.push("Only 1 public (unshield) output per transaction");
    }
    if (btcOutputCount > 1) {
      errors.push("Only 1 BTC output per transaction");
    }
    if (publicOutputCount > 0 && btcOutputCount > 0) {
      errors.push("Cannot mix public and BTC outputs (both need last position)");
    }

    // Validate recipients
    for (const o of outputs) {
      if (o.mode === "stealth" && !o.resolvedMeta) {
        errors.push("Resolve all stealth recipients");
        break;
      }
      if (o.mode === "public" && !isValidSolanaAddress(o.solanaAddress)) {
        errors.push("Enter valid Solana addresses");
        break;
      }
      if (o.mode === "note" && o.secretPhrase.trim().length < 8) {
        errors.push("Secret phrase must be at least 8 characters");
        break;
      }
      if (o.mode === "btc" && !o.btcAddress) {
        errors.push("Enter a valid Bitcoin address");
        break;
      }
    }

    return errors;
  }, [selectedNotes, outputs, totalOutputSats, totalInputSats, changeSats, nInputs, nOutputs, publicZkbtcBalance, hasImportedNotes]);

  const canSubmit = validationErrors.length === 0 && !loading;

  // ===== Main pay handler =====

  // Check if this is a public-only redeem (no shielded notes, only public zkBTC balance)
  const isPublicRedeem = hasBtcOutput && nInputs === 0 && publicZkbtcBalance > 0n;

  const handlePay = async () => {
    // Imported notes only need wallet for stealth address (self-change), not for keys
    if (!hasImportedNotes && !isPublicRedeem && (!publicKey || !keys || !signTransaction || !canSubmit)) return;
    if (hasImportedNotes && !canSubmit) return;
    if (isPublicRedeem && (!publicKey || !signTransaction || !canSubmit)) return;

    setLoading(true);
    setError(null);
    setStep("proving");
    setProofStatus("Initializing...");

    try {
      // ===== PUBLIC REDEEM PATH (no ZK proof needed) =====
      if (isPublicRedeem) {
        const btcOut = outputs.find(o => o.mode === "btc")!;
        const amountSats = BigInt(parseSats(btcOut.amount) ?? 0);
        const requestNonce = BigInt(Date.now());

        setProofStatus("Building public redeem transaction...");
        const { buildPublicRedeemInstructionData } = await import("@aegis/sdk");

        const ixData = buildPublicRedeemInstructionData({
          amountSats,
          btcScript: btcOut.btcScriptPubKey!,
          requestNonce,
        });

        const [poolState] = derivePoolStatePDA();
        const [redemptionRequest] = deriveRedemptionRequestPDA(publicKey!, requestNonce);
        const userTokenAccount = getTokenAccountAddress(publicKey!);

        const publicRedeemIx = new TransactionInstruction({
          programId: AEGIS_PROGRAM_ID,
          keys: [
            { pubkey: poolState, isSigner: false, isWritable: true },
            { pubkey: ZBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: publicKey!, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: redemptionRequest, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(ixData),
        });

        setProofStatus("Submitting transaction...");
        const tx = new Transaction().add(publicRedeemIx);
        tx.feePayer = publicKey!;
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;

        const signed = await signTransaction!(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");

        setRequestId(sig);
        setNoteOutputPhrases([]);
        setStep("success");
        refreshPublicBalance?.(publicKey!);
        return;
      }

      // ===== ZK PROOF PATH =====
      // Validate circuit availability before anything else
      const effectiveNInputs = hasImportedNotes ? activeImportedNotes.length : selectedNotes.length;
      const circuitKey = `${effectiveNInputs}x${outputs.length + (changeSats > 0 ? 1 : 0)}`;
      if (!AVAILABLE_CIRCUITS.has(circuitKey)) {
        throw new Error(
          `Circuit JoinSplit(${circuitKey}) is not available. ` +
          `Only tier-1 circuits (1x1, 1x2, 2x1, 2x2) are compiled. ` +
          `Adjust your inputs/outputs to fit.`
        );
      }

      await initPoseidon();

      const { computeJoinSplitCommitmentSync, createStealthDepositWithKeys,
              eddsaPoseidonSign, computeBoundParamsHash, DEFAULT_BOUND_PARAMS,
              createUnshieldBoundParams, poseidonHashSync,
              getCommitmentIndex: getCommitmentIndexSdk } = await import("@aegis/sdk");

      // Build input data: either from imported note or from inbox notes
      let inputsData: {
        note: { commitmentHex: string; leafIndex: number; amount: bigint };
        claimInputs: {
          npk: bigint;
          random: bigint;
          nullifyingKey: bigint;
          nullifier: bigint;
          merkleRoot: bigint;
          merklePath: bigint[];
          merkleIndices: number[];
        };
        // For imported notes: phrase-derived AegisKeys
        importedKeys?: import("@aegis/sdk").AegisKeys;
      }[];

      if (hasImportedNotes) {
        // Imported notes path: use phrase-derived keys via standard prepareClaimInputs
        setProofStatus(`Fetching Merkle proof(s) for ${activeImportedNotes.length} imported note(s)...`);

        // Fetch all announcements once
        const announcementsResp = await fetch("/api/stealth/announcements");
        const announcementsData = await announcementsResp.json();
        const allAnns = announcementsData.announcements || [];

        const hexToBytes = (hex: string) => {
          const h = hex.startsWith("0x") ? hex.slice(2) : hex;
          const b = new Uint8Array(h.length / 2);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
          return b;
        };

        const { scanUnifiedNotes: scanNotes } = await import("@aegis/sdk");

        inputsData = await Promise.all(activeImportedNotes.map(async (impNote) => {
          const resp = await fetch(`/api/merkle/proof?commitment=${impNote.commitment}`);
          const merkle = await resp.json();
          if (!merkle.success) {
            throw new Error(`Imported note ${impNote.commitment.slice(0, 16)}... not found on-chain`);
          }

          const matchingAnn = allAnns.find(
            (ann: { commitment: string }) => ann.commitment === impNote.commitment
          );
          if (!matchingAnn) {
            throw new Error(`Stealth announcement not found for note ${impNote.commitment.slice(0, 16)}...`);
          }

          const parsedAnns = [{
            announcementType: matchingAnn.announcementType,
            ephemeralPub: hexToBytes(matchingAnn.ephemeralPub),
            encryptedAmount: hexToBytes(matchingAnn.encryptedAmount),
            commitment: hexToBytes(matchingAnn.commitment),
            leafIndex: matchingAnn.leafIndex,
          }];

          const scanned = await scanNotes(impNote.keys, parsedAnns);
          if (scanned.length === 0) {
            throw new Error(`Failed to scan imported note ${impNote.commitment.slice(0, 16)}...`);
          }

          const scannedNote: ScannedNote = scanned[0];
          const realMerkleProof = {
            root: BigInt("0x" + merkle.root),
            pathElements: (merkle.siblings as string[]).map((s: string) => BigInt("0x" + s)),
            pathIndices: merkle.indices as number[],
          };

          const claimInputs = await prepareClaimInputs(impNote.keys, scannedNote, realMerkleProof);

          return {
            note: {
              commitmentHex: impNote.commitment,
              leafIndex: Number(impNote.leafIndex),
              amount: BigInt(impNote.amount),
            },
            claimInputs,
            importedKeys: impNote.keys,
          };
        }));
      } else {
        // Standard inbox notes path
        setProofStatus(`Fetching ${selectedNotes.length} Merkle proof(s)...`);

        const merkleResults = await Promise.all(
          selectedNotes.map(async (note) => {
            const resp = await fetch(`/api/merkle/proof?commitment=${note.commitmentHex}`);
            const data = await resp.json();
            if (!data.success) {
              throw new Error(`Note ${note.commitmentHex.slice(0, 16)}... not found on-chain`);
            }
            return { note, merkle: data };
          })
        );

        // Validate all proofs share the same merkle root
        const roots = merkleResults.map((r) => r.merkle.root);
        if (new Set(roots).size > 1) {
          throw new Error("Input notes have different Merkle roots — tree may have changed");
        }

        // Prepare claim inputs for each input note
        setProofStatus("Deriving stealth keys...");

        inputsData = await Promise.all(
          merkleResults.map(async ({ note, merkle }) => {
            const scannedNote: ScannedNote = {
              amount: typeof note.amount === "bigint" ? note.amount : BigInt(note.amount || 0),
              ephemeralPub: note.ephemeralPub,
              stealthPub: {
                x: typeof note.stealthPub?.x === "bigint" ? note.stealthPub.x : BigInt(note.stealthPub?.x || 0),
                y: typeof note.stealthPub?.y === "bigint" ? note.stealthPub.y : BigInt(note.stealthPub?.y || 0),
              },
              leafIndex: note.leafIndex,
              commitment: note.commitment,
            };

            const realMerkleProof = {
              root: BigInt("0x" + merkle.root),
              pathElements: (merkle.siblings as string[]).map((s: string) => BigInt("0x" + s)),
              pathIndices: merkle.indices as number[],
            };

            const claimInputs = await prepareClaimInputs(keys!, scannedNote, realMerkleProof);

            // Verify commitment
            const derivedCommitment = computeJoinSplitCommitmentSync(
              claimInputs.npk, ZBTC_TOKEN_ID, scannedNote.amount
            );
            const derivedHex = derivedCommitment.toString(16).padStart(64, "0");
            if (derivedHex !== note.commitmentHex.toLowerCase()) {
              throw new Error(`Commitment mismatch for note ${note.commitmentHex.slice(0, 16)}...`);
            }

            return {
              note: {
                commitmentHex: note.commitmentHex,
                leafIndex: note.leafIndex,
                amount: scannedNote.amount,
              },
              claimInputs,
            };
          })
        );
      }

      // 3. Prepare outputs — use createStealthDepositWithKeys for ALL outputs
      // so that npk (for commitment) and stealth data (ephemeralPub + encryptedAmount)
      // come from the SAME ECDH shared secret. Otherwise scanner can't find notes.
      setProofStatus("Preparing outputs...");

      const selfMeta = stealthAddress ? {
        spendingPubKey: new Uint8Array(32),
        viewingPubKey: stealthAddress.viewingPubKey,
        mpk: stealthAddress.mpk,
      } : null;

      const sendAmounts: bigint[] = [];
      const recipientNpks: bigint[] = [];
      // Store the full stealth-with-keys result for each output (including public/change)
      const stealthResults: Awaited<ReturnType<typeof createStealthDepositWithKeys>>[] = [];

      // Reorder outputs: stealth/note first, then public/btc (unshield/redeem) last
      // This ensures the unshield/redeem output is the last commitment in the proof
      const hasSpecialLastOutput = outputs.some(o => o.mode === "public" || o.mode === "btc");
      const orderedOutputs = hasSpecialLastOutput
        ? [...outputs.filter(o => o.mode !== "public" && o.mode !== "btc"), ...outputs.filter(o => o.mode === "public" || o.mode === "btc")]
        : outputs;

      for (const output of orderedOutputs) {
        const sats = parseSats(output.amount) ?? 0;
        const amount = BigInt(sats);
        sendAmounts.push(amount);

        if (output.mode === "btc") {
          // BTC redeem output: needs npk for ZK proof commitment, but NOT inserted into tree
          // Use self stealth address to generate a valid commitment
          if (!selfMeta) throw new Error("Cannot create BTC output without stealth address");
          const result = await createStealthDepositWithKeys(selfMeta, amount);
          recipientNpks.push(result.stealthPubKeyX);
          // Dummy stealth result — redeem output has no announcement (sliced off like unshield)
          stealthResults.push({
            ephemeralPub: new Uint8Array(32),
            encryptedAmount: new Uint8Array(8),
            stealthPubKeyX: result.stealthPubKeyX,
          } as Awaited<ReturnType<typeof createStealthDepositWithKeys>>);
        } else if (output.mode === "public") {
          // Unshield output: use Solana recipient address as "npk"
          // On-chain expects: commitment = Poseidon(reduce_to_field(solana_address), ZBTC_TOKEN_ID, amount)
          // Must match on-chain reduce_to_field exactly (mask approach, not modular reduction)
          const addrBytes = new PublicKey(output.solanaAddress).toBytes();
          const addrReduced = reduceToFieldOnChain(addrBytes);
          recipientNpks.push(addrReduced);
          // Dummy stealth result — will be sliced off (unshield output has no announcement)
          stealthResults.push({
            ephemeralPub: new Uint8Array(32),
            encryptedAmount: new Uint8Array(8),
            stealthPubKeyX: addrReduced,
          } as Awaited<ReturnType<typeof createStealthDepositWithKeys>>);
        } else if (output.mode === "note") {
          // Note output: derive full AegisKeys from phrase, create proper stealth deposit
          // Must use deriveKeysFromSeedCircuit so spendingPubKey matches circomlibjs EdDSA
          // (sync-derived keys produce a different pubkey that fails EdDSAPoseidonVerifier)
          const masterKey = deriveMasterKey(output.secretPhrase.trim());
          const noteKeys = await deriveKeysFromSeedCircuit(masterKey);
          const noteMeta = createStealthMetaAddress(noteKeys);
          const result = await createStealthDepositWithKeys(noteMeta, amount);
          recipientNpks.push(result.stealthPubKeyX);
          stealthResults.push(result);
        } else if (output.mode === "stealth" && output.resolvedMeta) {
          // Stealth output: single call provides BOTH npk AND stealth data
          const result = await createStealthDepositWithKeys(output.resolvedMeta, amount);
          recipientNpks.push(result.stealthPubKeyX);
          stealthResults.push(result);
        } else {
          // Self output: create stealth deposit to self for scannable notes
          if (!selfMeta) throw new Error("Cannot create output without stealth address");
          const result = await createStealthDepositWithKeys(selfMeta, amount);
          recipientNpks.push(result.stealthPubKeyX);
          stealthResults.push(result);
        }
      }

      // Add change output — always goes BEFORE the unshield output
      // For unshield: stealth outputs → change → unshield (last)
      const changeAmount = BigInt(changeSats);
      let changeNotePhrase: string | null = null;
      if (changeAmount > 0n) {
        let changeMeta: StealthMetaAddress | null = null;

        if (hasImportedNotes) {
          // Imported note: change goes back to the same phrase so the user can reclaim it
          changeNotePhrase = importPhrase.trim();
          const changeMasterKey = deriveMasterKey(changeNotePhrase);
          const changeKeys = await deriveKeysFromSeedCircuit(changeMasterKey);
          changeMeta = createStealthMetaAddress(changeKeys);
        } else {
          if (!selfMeta) throw new Error("Cannot create change output without stealth address");
          changeMeta = selfMeta;
        }

        const changeResult = await createStealthDepositWithKeys(changeMeta!, changeAmount);

        if (hasSpecialLastOutput) {
          // Insert change BEFORE the unshield/redeem output (which is currently last)
          const insertIdx = sendAmounts.length - 1;
          sendAmounts.splice(insertIdx, 0, changeAmount);
          recipientNpks.splice(insertIdx, 0, changeResult.stealthPubKeyX);
          stealthResults.splice(insertIdx, 0, changeResult);
        } else {
          sendAmounts.push(changeAmount);
          recipientNpks.push(changeResult.stealthPubKeyX);
          stealthResults.push(changeResult);
        }
      }

      // 4. Compute output commitments
      const outCommitments = recipientNpks.map((npk, i) =>
        computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, sendAmounts[i])
      );

      // 5. Compute bound params hash
      setProofStatus("Signing transaction...");
      const merkleRoot = inputsData[0].claimInputs.merkleRoot;

      // Detect special output modes
      const publicOutput = outputs.find(o => o.mode === "public");
      const btcOutput = outputs.find(o => o.mode === "btc");
      const isPublicUnshield = !!publicOutput;
      const isBtcRedeem = !!btcOutput;
      let boundParamsHash: bigint;
      let unshieldRecipientAddress: Uint8Array | null = null;

      const { createRedeemBoundParams } = await import("@aegis/sdk");

      if (isBtcRedeem) {
        const redeemParams = createRedeemBoundParams();
        boundParamsHash = computeBoundParamsHash(redeemParams);
      } else if (isPublicUnshield) {
        const recipientPubkey = new PublicKey(publicOutput.solanaAddress);
        unshieldRecipientAddress = recipientPubkey.toBytes();
        const unshieldParams = createUnshieldBoundParams(unshieldRecipientAddress);
        boundParamsHash = computeBoundParamsHash(unshieldParams);
      } else {
        boundParamsHash = computeBoundParamsHash(DEFAULT_BOUND_PARAMS);
      }

      const allNullifiers = inputsData.map((d) => d.claimInputs.nullifier);
      const msgHashInputs = [merkleRoot, boundParamsHash, ...allNullifiers, ...outCommitments];
      const msgHash = poseidonHashSync(msgHashInputs);

      // Use phrase-derived keys for imported notes, wallet-derived keys for inbox notes
      let sigR8x: bigint, sigR8y: bigint, sigS: bigint;
      let proofPublicKey: [bigint, bigint];
      let proofNullifyingKey: bigint;

      if (hasImportedNotes && inputsData[0].importedKeys) {
        const ik = inputsData[0].importedKeys;
        // Use circomlibjs EdDSA signing (keys from deriveKeysFromSeedCircuit are circuit-compatible)
        [sigR8x, sigR8y, sigS] = await eddsaPoseidonSign(ik.eddsaSeed, msgHash);
        proofPublicKey = [ik.spendingPubKey.x, ik.spendingPubKey.y];
        proofNullifyingKey = ik.nullifyingKey;
      } else {
        [sigR8x, sigR8y, sigS] = await eddsaPoseidonSign(keys!.eddsaSeed, msgHash);
        proofPublicKey = [keys!.spendingPubKey.x, keys!.spendingPubKey.y];
        proofNullifyingKey = inputsData[0].claimInputs.nullifyingKey;
      }

      // 6. Build JoinSplit proof inputs
      setProofStatus("Generating JoinSplit proof...");

      if (!prover.isInitialized) {
        await prover.initialize();
      }

      const actualNOutputs = sendAmounts.length;

      const joinsplitInputs: JoinSplitProofInputs = {
        nInputs: effectiveNInputs,
        nOutputs: actualNOutputs,
        merkleRoot,
        boundParamsHash,
        token: ZBTC_TOKEN_ID,
        publicKey: proofPublicKey,
        signature: [sigR8x, sigR8y, sigS],
        nullifyingKey: proofNullifyingKey,
        inputs: inputsData.map(({ note, claimInputs }) => ({
          random: claimInputs.random,
          value: note.amount,
          leafIndex: BigInt(note.leafIndex),
          merkleProof: {
            siblings: claimInputs.merklePath,
            indices: claimInputs.merkleIndices,
          },
        })),
        outputs: recipientNpks.map((npk, i) => ({
          npk,
          value: sendAmounts[i],
        })),
      };

      const { proofBytes } = await prover.generateProof(joinsplitInputs);

      // 7. Build stealth data and submit
      setProofStatus("Submitting transaction...");

      const stealthDataArrays: Uint8Array[] = stealthResults.map((result) => {
        const sd = new Uint8Array(40);
        sd.set(result.ephemeralPub, 0);
        sd.set(result.encryptedAmount, 32);
        return sd;
      });

      const merkleRootHex = merkleRoot.toString(16).padStart(64, "0");
      const nullifierHexes = allNullifiers.map((n) => n.toString(16).padStart(64, "0"));
      const commitmentHexes = outCommitments.map((c) => c.toString(16).padStart(64, "0"));

      let relayResult: { success: boolean; signature?: string; error?: string };

      if (isBtcRedeem && btcOutput) {
        // BTC Redeem: build redeem instruction and have user sign directly
        const { buildRedeemInstructionData } = await import("@aegis/sdk");
        const redeemAmountSats = BigInt(parseSats(btcOutput.amount) ?? 0);
        const requestNonce = BigInt(Date.now());

        // Tree outputs = all except the last (redeem output)
        const treeStealthData = stealthDataArrays.slice(0, -1);

        const redeemIxData = buildRedeemInstructionData({
          nInputs: effectiveNInputs,
          nOutputs: actualNOutputs,
          proofBytes,
          merkleRoot: bigintTo32Bytes(merkleRoot),
          boundParamsHash: bigintTo32Bytes(boundParamsHash),
          nullifiers: allNullifiers.map(n => bigintTo32Bytes(n)),
          commitmentsOut: outCommitments.map(c => bigintTo32Bytes(c)),
          stealthData: treeStealthData,
          redeemAmount: redeemAmountSats,
          btcScript: btcOutput.btcScriptPubKey!,
          requestNonce,
        });

        // Derive PDAs
        const [poolState] = derivePoolStatePDA();
        const [commitmentTree] = deriveCommitmentTreePDA();
        const [vkRegistry] = deriveVkRegistryPDA(effectiveNInputs, actualNOutputs);
        const [redemptionRequest] = deriveRedemptionRequestPDA(publicKey!, requestNonce);

        const nullifierPDAs = allNullifiers.map(n => {
          const [pda] = deriveNullifierPDA(bigintTo32Bytes(n));
          return pda;
        });

        const stealthAnnouncementPDAs = treeStealthData.map(sd => {
          const ephPub = sd.slice(0, 32);
          const [pda] = deriveTransferStealthAnnouncementPDA(ephPub);
          return pda;
        });

        const redeemAccounts = [
          { pubkey: poolState, isSigner: false, isWritable: true },
          { pubkey: commitmentTree, isSigner: false, isWritable: true },
          { pubkey: vkRegistry, isSigner: false, isWritable: false },
          { pubkey: publicKey!, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ...nullifierPDAs.map(pda => ({ pubkey: pda, isSigner: false, isWritable: true })),
          ...stealthAnnouncementPDAs.map(pda => ({ pubkey: pda, isSigner: false, isWritable: true })),
          { pubkey: redemptionRequest, isSigner: false, isWritable: true },
        ];

        const redeemIx = new TransactionInstruction({
          programId: AEGIS_PROGRAM_ID,
          keys: redeemAccounts,
          data: Buffer.from(redeemIxData),
        });

        const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
        const tx = new Transaction().add(computeIx, redeemIx);
        tx.feePayer = publicKey!;
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;

        const signed = await signTransaction!(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        relayResult = { success: true, signature: sig };
      } else if (isPublicUnshield && unshieldRecipientAddress) {
        // Public unshield: call /api/unshield
        // The unshield output is the LAST commitment — stealth data is only for tree outputs (all except last)
        const unshieldAmount = parseSats(publicOutput!.amount) ?? 0;

        // Get or create associated token account for recipient
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const recipientPubkey = new PublicKey(publicOutput!.solanaAddress);
        const zbtcMint = new PublicKey(DEVNET_CONFIG.zbtcMint);
        const TOKEN_2022_PID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        const recipientTokenAccount = getAssociatedTokenAddressSync(
          zbtcMint, recipientPubkey, false, TOKEN_2022_PID
        );

        // Tree outputs = all except the last (unshield output)
        const treeStealthData = stealthDataArrays.slice(0, -1);

        const relayResponse = await fetch("/api/unshield", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nInputs: effectiveNInputs,
            nOutputs: actualNOutputs,
            proof: bytesToHex(proofBytes),
            merkleRoot: merkleRootHex,
            boundParamsHash: boundParamsHash.toString(16).padStart(64, "0"),
            nullifiers: nullifierHexes,
            commitmentsOut: commitmentHexes,
            stealthData: treeStealthData.map((sd) => bytesToHex(sd)),
            unshieldAmount: unshieldAmount.toString(),
            recipientAddress: recipientPubkey.toBase58(),
            recipientTokenAccount: recipientTokenAccount.toBase58(),
          }),
        });

        relayResult = await relayResponse.json();
      } else {
        // Private transfer: call /api/relay
        const relayResponse = await fetch("/api/relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nInputs: effectiveNInputs,
            nOutputs: actualNOutputs,
            proof: bytesToHex(proofBytes),
            merkleRoot: merkleRootHex,
            boundParamsHash: boundParamsHash.toString(16).padStart(64, "0"),
            nullifiers: nullifierHexes,
            commitmentsOut: commitmentHexes,
            stealthData: stealthDataArrays.map((sd) => bytesToHex(sd)),
          }),
        });

        relayResult = await relayResponse.json();
      }

      if (!relayResult.success) {
        throw new Error(relayResult.error || "Transaction failed");
      }

      setRequestId(relayResult.signature ?? null);
      if (changeSats > 0) {
        setChangeAmountSats(changeSats);
      }
      // Capture Note output phrases for claim links in success
      const notePhrases = outputs
        .filter(o => o.mode === "note" && o.secretPhrase.trim().length >= 8)
        .map(o => ({ phrase: o.secretPhrase.trim(), amount: parseSats(o.amount) ?? 0 }));
      // Include auto-generated change note phrase (from imported note flow)
      if (changeNotePhrase && changeSats > 0) {
        notePhrases.push({ phrase: changeNotePhrase, amount: changeSats });
      }
      setNoteOutputPhrases(notePhrases);
      setStep("success");
    } catch (err) {
      console.error("[Pay] Error:", err);
      setError(err instanceof Error ? err.message : "Failed to process payment");
      setStep("compose");
    } finally {
      setLoading(false);
      setProofStatus("");
    }
  };

  // Track Note output phrases for success display
  const [noteOutputPhrases, setNoteOutputPhrases] = useState<{ phrase: string; amount: number }[]>([]);

  const resetFlow = () => {
    setStep(availableNotes.length > 0 ? "compose" : "connect");
    setSelectedNoteIds(new Set());
    setShowNoteSelector(false);
    setOutputs([createOutputRow(defaultOutputMode, publicKey?.toBase58() || "")]);
    setError(null);
    setRequestId(null);
    setChangeAmountSats(0);
    clearImportedNote();
    setNoteOutputPhrases([]);
  };

  // ===== CONNECT STEP =====
  if (step === "connect") {
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
          <button onClick={deriveKeys} disabled={keysLoading} className="btn-primary w-full justify-center">
            {keysLoading ? "Deriving..." : "Derive Keys"}
          </button>
        </div>
      );
    }

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
          <button onClick={handleRefresh} disabled={inboxLoading} className="btn-secondary w-full justify-center">
            {inboxLoading ? "Scanning..." : "Refresh Inbox"}
          </button>
        </div>
      );
    }

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

  // ===== COMPOSE STEP =====
  if (step === "compose") {
    return (
      <div className="flex flex-col text-start">
        {/* === INPUTS SECTION === */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-body2-semibold text-gray-light uppercase tracking-wider text-xs">
              Inputs
            </p>
            {!hasImportedNotes && !(initialSecretPhrase && (importLoading || importError)) && (
              <button
                onClick={() => setShowNoteSelector(!showNoteSelector)}
                className="text-caption text-purple hover:text-purple/80 transition-colors"
              >
                {showNoteSelector ? "Done" : "Edit"}
              </button>
            )}
          </div>

          {hasImportedNotes ? null : initialSecretPhrase && !hasImportedNotes && (importLoading || importError) ? (
            /* When coming from ?note= link and scan failed or loading, don't show inbox notes */
            importLoading ? (
              <div className="p-4 rounded-[10px] bg-muted border border-gray/15 text-center mb-2">
                <Loader2 className="w-5 h-5 animate-spin text-btc mx-auto mb-2" />
                <p className="text-caption text-gray">Scanning secret phrase...</p>
              </div>
            ) : (
              <div className="p-4 rounded-[10px] bg-error/5 border border-error/20 text-center mb-2">
                <AlertCircle className="w-5 h-5 text-error mx-auto mb-2" />
                <p className="text-body2 text-error mb-1">No notes found</p>
                <p className="text-caption text-gray">{importError}</p>
                <button
                  onClick={clearImportedNote}
                  className="mt-3 text-caption text-purple hover:text-purple/80 underline transition-colors"
                >
                  Use wallet notes instead
                </button>
              </div>
            )
          ) : showNoteSelector ? (
            /* Full note selector with checkboxes */
            <div className="space-y-1.5 mb-2">
              {availableNotes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => toggleNoteSelection(note.id)}
                  className={cn(
                    "w-full flex items-center gap-3 p-3 rounded-[10px] text-left transition-all",
                    "border",
                    selectedNoteIds.has(note.id)
                      ? "bg-purple/10 border-purple/30"
                      : "bg-muted border-gray/15 hover:border-gray/30"
                  )}
                >
                  <div
                    className={cn(
                      "w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors",
                      selectedNoteIds.has(note.id)
                        ? "bg-purple border-purple"
                        : "border-gray/30"
                    )}
                  >
                    {selectedNoteIds.has(note.id) && (
                      <Check className="w-3 h-3 text-white" />
                    )}
                  </div>
                  <div className="flex-1 flex justify-between items-center">
                    <span className="text-body2-semibold text-foreground">
                      {formatBtc(Number(note.amount))} zkBTC
                    </span>
                    <span className="text-caption text-gray font-mono">
                      leaf #{note.leafIndex}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            /* Compact selected notes list */
            <div className="space-y-1.5 mb-2">
              {selectedNotes.length === 0 ? (
                <div className="p-3 rounded-[10px] bg-muted border border-gray/15 text-center">
                  <p className="text-caption text-gray">
                    No notes selected — enter amounts below to auto-select
                  </p>
                </div>
              ) : (
                selectedNotes.map((note) => (
                  <div
                    key={note.id}
                    className="flex items-center gap-2 p-2.5 rounded-[10px] bg-purple/5 border border-purple/20"
                  >
                    <Key className="w-4 h-4 text-purple shrink-0" />
                    <span className="text-body2-semibold text-foreground">
                      {formatBtc(Number(note.amount))} zkBTC
                    </span>
                    <span className="text-caption text-gray font-mono ml-auto">
                      leaf #{note.leafIndex}
                    </span>
                    <Check className="w-4 h-4 text-purple" />
                  </div>
                ))
              )}
            </div>
          )}

          {/* Imported notes display — only show unspent */}
          {activeImportedNotes.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {activeImportedNotes.map((impNote, idx) => (
                <div
                  key={`imp-${idx}`}
                  className="p-2.5 rounded-[10px] border bg-btc/5 border-btc/20"
                >
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4 text-btc shrink-0" />
                    <span className="text-body2-semibold text-foreground">
                      {formatBtc(impNote.amount)} zkBTC
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-btc/15 text-btc font-medium">
                      imported
                    </span>
                    <span className="text-caption text-gray font-mono ml-auto">
                      leaf #{Number(impNote.leafIndex)}
                    </span>
                    {idx === 0 && (
                      <button
                        onClick={clearImportedNote}
                        className="p-1 rounded text-gray/50 hover:text-error transition-colors"
                        title="Remove imported notes"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Import from Secret button/form — hide when ?note= scan failed (error shown above) */}
          {!hasImportedNotes && !(initialSecretPhrase && (importLoading || importError)) && (
            showImportInput ? (
              <div className="mb-2 p-3 rounded-[10px] bg-muted border border-btc/20">
                <div className="flex items-center gap-2 mb-2">
                  <Key className="w-4 h-4 text-btc" />
                  <span className="text-caption text-gray-light">Import from Secret Phrase</span>
                  <button
                    onClick={() => { setShowImportInput(false); setImportPhrase(""); setImportError(null); }}
                    className="ml-auto p-1 rounded text-gray/50 hover:text-gray-light transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={importPhrase}
                    onChange={(e) => setImportPhrase(e.target.value)}
                    placeholder="Enter secret phrase..."
                    className={cn(
                      "flex-1 px-3 py-2 bg-background border border-gray/20 rounded-[8px]",
                      "text-body2 font-mono text-foreground placeholder:text-gray/40",
                      "outline-none focus:border-btc/40 transition-colors"
                    )}
                    onKeyDown={(e) => { if (e.key === "Enter") handleImportScan(); }}
                  />
                  <button
                    onClick={() => handleImportScan()}
                    disabled={importLoading || importPhrase.trim().length < 8}
                    className={cn(
                      "px-3 py-2 rounded-[8px] text-caption font-medium transition-colors",
                      "bg-btc/20 text-btc hover:bg-btc/30",
                      "disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                  >
                    {importLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Search className="w-4 h-4" />
                    )}
                  </button>
                </div>
                {importError && (
                  <p className="text-[11px] text-error mt-1.5 pl-1">{importError}</p>
                )}
              </div>
            ) : (
              <button
                onClick={() => setShowImportInput(true)}
                className="mb-2 w-full flex items-center justify-center gap-1.5 py-2 rounded-[8px] text-caption text-btc hover:bg-btc/5 border border-dashed border-btc/20 hover:border-btc/40 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Import from Secret
              </button>
            )
          )}

          {/* Disable inbox note selector when imported notes are active */}
          {hasImportedNotes && selectedNotes.length > 0 && (
            <p className="text-[11px] text-gray mb-2 pl-1">
              Inbox notes disabled while using imported notes
            </p>
          )}

          {/* Input total */}
          <div className="flex justify-between items-center px-2 text-body2">
            <span className="text-gray">
              {isPublicRedeem ? "Public zkBTC Balance" : "Total Input"}
            </span>
            <span className="text-foreground font-semibold">
              {isPublicRedeem ? formatBtc(Number(publicZkbtcBalance)) : formatBtc(totalInputSats)} zkBTC
            </span>
          </div>
        </div>

        <div className="border-t border-gray/10 my-2" />

        {/* === OUTPUTS SECTION === */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-body2-semibold text-gray-light uppercase tracking-wider text-xs">
              Outputs
            </p>
            {outputs.length < MAX_OUTPUTS && (
              <button
                onClick={addOutput}
                className="flex items-center gap-1 text-caption text-purple hover:text-purple/80 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add Output
              </button>
            )}
          </div>

          <div className="space-y-3">
            {outputs.map((output, index) => (
              <OutputRowCard
                key={output.id}
                output={output}
                index={index}
                canRemove={outputs.length > 1}
                onUpdate={(update) => updateOutput(output.id, update)}
                onRemove={() => removeOutput(output.id)}
                defaultAddress={publicKey?.toBase58() || ""}
                disablePublic={outputs.some(o => o.id !== output.id && (o.mode === "public" || o.mode === "btc"))}
                disableBtc={outputs.some(o => o.id !== output.id && (o.mode === "btc" || o.mode === "public"))}
              />
            ))}
          </div>
        </div>

        {/* === PUBLIC zkBTC BALANCE === */}
        {publicZkbtcBalance > 0n && (
          <div className="mb-4 p-3 rounded-[12px] bg-privacy/5 border border-privacy/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wallet className="w-4 h-4 text-privacy" />
                <span className="text-body2 text-gray-light">Public zkBTC</span>
              </div>
              <span className="text-body2-semibold text-privacy">
                {formatBtc(Number(publicZkbtcBalance))} zkBTC
              </span>
            </div>
            {hasBtcOutput && (
              <p className="text-[11px] text-gray mt-1.5 pl-6">
                Can be redeemed to BTC without ZK proof via Public Redeem
              </p>
            )}
          </div>
        )}

        <div className="border-t border-gray/10 my-2" />

        {/* === SUMMARY === */}
        <div className="mb-4 p-3 rounded-[12px] bg-muted border border-gray/15">
          {/* Show breakdown if mixed outputs */}
          {(hasPublicOutput || hasBtcOutput) && outputs.some(o => o.mode === "stealth" || o.mode === "note") && (
            <>
              <div className="flex justify-between items-center text-body2 mb-1">
                <span className="text-gray flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-purple" /> Stealth
                </span>
                <span className="text-purple font-semibold">
                  {outputs.filter(o => o.mode === "stealth" || o.mode === "note").reduce((s, o) => s + (parseSats(o.amount) ?? 0), 0).toLocaleString()} sats
                </span>
              </div>
              {hasPublicOutput && (
                <div className="flex justify-between items-center text-body2 mb-1">
                  <span className="text-gray flex items-center gap-1.5">
                    <Wallet className="w-3.5 h-3.5 text-privacy" /> Unshield
                  </span>
                  <span className="text-privacy font-semibold">
                    {outputs.filter(o => o.mode === "public").reduce((s, o) => s + (parseSats(o.amount) ?? 0), 0).toLocaleString()} sats
                  </span>
                </div>
              )}
              {hasBtcOutput && (
                <div className="flex justify-between items-center text-body2 mb-1">
                  <span className="text-gray flex items-center gap-1.5">
                    <Bitcoin className="w-3.5 h-3.5 text-btc" /> BTC Withdrawal
                  </span>
                  <span className="text-btc font-semibold">
                    {outputs.filter(o => o.mode === "btc").reduce((s, o) => s + (parseSats(o.amount) ?? 0), 0).toLocaleString()} sats
                  </span>
                </div>
              )}
              <div className="border-t border-gray/10 my-1" />
            </>
          )}
          <div className="flex justify-between items-center text-body2 mb-1">
            <span className="text-gray">
              {hasPublicOutput || hasBtcOutput ? "Total" : "Send Total"}
            </span>
            <span className="text-foreground font-semibold">
              {totalOutputSats.toLocaleString()} sats
            </span>
          </div>
          {!isPublicRedeem && (
            <div className="flex justify-between items-center text-body2 mb-1">
              <span className="text-gray">{hasImportedNotes ? "Change (as Note)" : "Change (kept shielded)"}</span>
              <span className={cn(
                "font-semibold",
                changeSats >= 0 ? "text-privacy" : "text-error"
              )}>
                {changeSats >= 0 ? formatBtc(changeSats) : "-" + formatBtc(-changeSats)} zkBTC
              </span>
            </div>
          )}
          <div className="flex justify-between items-center text-body2 pt-1 border-t border-gray/10">
            <span className="text-gray">{isPublicRedeem ? "Type" : "Circuit"}</span>
            <span className={cn("font-mono text-xs", isPublicRedeem ? "text-btc" : "text-purple")}>
              {isPublicRedeem
                ? "Public Redeem (no ZK proof)"
                : <>
                    JoinSplit({nInputs},{nOutputs})
                    {hasPublicOutput && " + Unshield"}
                    {hasBtcOutput && " + Redeem"}
                  </>
              }
            </span>
          </div>
        </div>

        {/* Processing time info */}
        <div className="flex items-center gap-3 p-3 bg-muted border border-gray/15 rounded-[12px] mb-4">
          <Clock className="w-5 h-5 text-gray shrink-0" />
          <div className="text-caption text-gray">
            <span className="text-gray-light">Processing time:</span>{" "}
            {isPublicRedeem ? "~5s (no proof needed)" : "30-60s (ZK proof generation)"}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="warning-box mb-4">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Validation errors */}
        {validationErrors.length > 0 && !error && (
          <div className="mb-4 p-2.5 rounded-[10px] bg-gray/5 border border-gray/10">
            <p className="text-caption text-gray">{validationErrors[0]}</p>
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handlePay}
          disabled={!canSubmit}
          className={cn("w-full", hasBtcOutput ? "btn-bitcoin" : "btn-primary")}
        >
          {isPublicRedeem ? (
            <>
              <Bitcoin className="w-5 h-5" />
              Redeem Public zkBTC to BTC
            </>
          ) : hasBtcOutput ? (
            <>
              <Bitcoin className="w-5 h-5" />
              Generate Proof & Withdraw to BTC
            </>
          ) : (
            <>
              <Shield className="w-5 h-5" />
              {hasPublicOutput
                ? outputs.some(o => o.mode === "stealth") ? "Unshield + Send Private" : "Unshield to Wallet"
                : "Generate Proof & Pay"}
            </>
          )}
        </button>
      </div>
    );
  }

  // ===== PROVING STEP =====
  if (step === "proving") {
    const displayStatus =
      prover.isGenerating && prover.progress
        ? prover.progress
        : proofStatus || "Initializing...";

    return (
      <div className="flex flex-col items-center py-6">
        <StepIndicator current={step} />

        <div className="relative w-16 h-16 mb-4">
          <div className="absolute inset-0 rounded-full border-4 border-gray/15" />
          <div
            className="absolute inset-0 rounded-full border-4 border-purple border-t-transparent animate-spin"
            style={{ animationDuration: "2s" }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <Zap className="w-6 h-6 text-purple" />
          </div>
        </div>

        <p className="text-heading6 text-foreground mb-4">Processing Transaction</p>

        {/* Sub-step progress list */}
        <div className="w-full mb-4 p-4 bg-muted border border-gray/15 rounded-[12px]">
          <ProvingSubSteps status={displayStatus} />
          {prover.isGenerating && (
            <p className="text-caption text-gray mt-3 pl-8">
              ZK proof generation may take 30-60s...
            </p>
          )}
        </div>

        {prover.error && (
          <div className="w-full mb-4 p-3 bg-error/10 border border-error/20 rounded-[12px]">
            <div className="flex items-center gap-2 text-body2 text-error">
              <AlertCircle className="w-4 h-4" />
              <span>{prover.error}</span>
            </div>
          </div>
        )}

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

  // ===== SUCCESS STEP =====
  if (step === "success" && requestId) {
    const hasStealth = outputs.some((o) => o.mode === "stealth" || o.mode === "note");
    const successBtcOutput = outputs.find(o => o.mode === "btc");

    return (
      <div className="flex flex-col items-center">
        <StepIndicator current={step} />
        <div className={cn("rounded-full p-4 mb-4", successBtcOutput ? "bg-btc/10" : "bg-success/10")}>
          {successBtcOutput ? (
            <Bitcoin className="h-12 w-12 text-btc" />
          ) : (
            <CheckCircle2 className="h-12 w-12 text-success" />
          )}
        </div>

        <p className="text-heading6 text-foreground mb-2">
          {successBtcOutput ? "BTC Withdrawal Submitted!" : "Payment Complete!"}
        </p>
        <p className="text-body2 text-gray text-center mb-6">
          {successBtcOutput
            ? "Redemption request created on-chain. BTC will be sent to your address."
            : hasStealth
              ? "Stealth payment submitted on-chain"
              : "Your zBTC has been sent successfully"}
        </p>

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
            <span className="text-gray-light">Sent</span>
            <span className="text-privacy">{totalOutputSats.toLocaleString()} sats</span>
          </div>
          {changeAmountSats > 0 && (
            <div className="flex justify-between items-center text-body2">
              <span className="text-gray-light">Change</span>
              <span className="text-foreground">{formatBtc(changeAmountSats)} zkBTC</span>
            </div>
          )}
          {successBtcOutput && (
            <div className="flex justify-between items-center text-body2">
              <span className="text-gray-light">BTC Address</span>
              <span className="font-mono text-btc text-xs">
                {truncateMiddle(successBtcOutput.btcAddress || "", 8)}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center text-body2 pt-2 border-t border-gray/15">
            <span className="text-gray-light">Circuit</span>
            <span className="font-mono text-purple text-xs">
              JoinSplit({nInputs},{nOutputs})
              {successBtcOutput && " + Redeem"}
            </span>
          </div>
        </div>

        {/* Claim links for Note outputs */}
        {noteOutputPhrases.length > 0 && (
          <div className="w-full mb-4 space-y-2">
            {noteOutputPhrases.map((np, i) => (
              <NoteClaimLink key={i} phrase={np.phrase} amount={np.amount} />
            ))}
          </div>
        )}

        <div className="w-full flex items-center gap-3 p-3 bg-privacy/10 border border-privacy/20 rounded-[12px] mb-6">
          <CheckCircle2 className="w-5 h-5 text-privacy shrink-0" />
          <p className="text-caption text-gray-light">
            {hasStealth
              ? "Recipient can scan and claim using their stealth keys"
              : "Deposit created on-chain. You can scan and claim it in Notes."}
          </p>
        </div>

        <button onClick={resetFlow} className="btn-tertiary w-full">
          <Send className="w-5 h-5" />
          Make Another Payment
        </button>
      </div>
    );
  }

  return null;
}

// ===== NOTE CLAIM LINK COMPONENT =====

function NoteClaimLink({ phrase, amount }: { phrase: string; amount: number }) {
  const [copied, setCopied] = useState(false);
  const claimUrl = typeof window !== "undefined"
    ? `${window.location.origin}/claim?note=${encodeURIComponent(phrase)}`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(claimUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="p-3 rounded-[12px] bg-btc/5 border border-btc/20">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-btc" />
          <span className="text-body2-semibold text-foreground">
            Note: {formatBtc(amount)} zkBTC
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-caption text-btc hover:text-btc/80 transition-colors"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? "Copied!" : "Copy Link"}
        </button>
      </div>
      <div className="p-2 bg-background rounded-[8px] break-all">
        <code className="text-[11px] font-mono text-gray-light">{claimUrl}</code>
      </div>
      <p className="text-[11px] text-gray mt-1.5">
        Share this link to let someone claim this note
      </p>
    </div>
  );
}

// ===== OUTPUT ROW CARD COMPONENT =====

interface OutputRowCardProps {
  output: OutputRow;
  index: number;
  canRemove: boolean;
  onUpdate: (update: Partial<OutputRow>) => void;
  onRemove: () => void;
  defaultAddress: string;
  disablePublic?: boolean;
  disableBtc?: boolean;
}

function OutputRowCard({
  output,
  index,
  canRemove,
  onUpdate,
  onRemove,
  defaultAddress,
  disablePublic = false,
  disableBtc = false,
}: OutputRowCardProps) {
  const [isEditingAddress, setIsEditingAddress] = useState(false);

  const isOwnWallet = output.solanaAddress === defaultAddress;

  return (
    <div className="p-3 rounded-[12px] bg-card border border-gray/15">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-caption text-gray">Output {index + 1}</span>
        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex gap-1">
            <button
              onClick={() => onUpdate({ mode: "stealth", addressError: null })}
              className={cn(
                "px-2 py-1 rounded-[6px] text-[11px] font-medium transition-colors",
                output.mode === "stealth"
                  ? "bg-purple/20 text-purple"
                  : "text-gray hover:text-gray-light"
              )}
            >
              Stealth
            </button>
            <button
              onClick={() => onUpdate({ mode: "note", addressError: null, stealthError: null })}
              className={cn(
                "px-2 py-1 rounded-[6px] text-[11px] font-medium transition-colors",
                output.mode === "note"
                  ? "bg-btc/20 text-btc"
                  : "text-gray hover:text-gray-light"
              )}
            >
              Note
            </button>
            <button
              onClick={() => !disablePublic && onUpdate({ mode: "public", stealthError: null, solanaAddress: defaultAddress })}
              disabled={disablePublic && output.mode !== "public"}
              className={cn(
                "px-2 py-1 rounded-[6px] text-[11px] font-medium transition-colors",
                output.mode === "public"
                  ? "bg-privacy/20 text-privacy"
                  : disablePublic
                    ? "text-gray/30 cursor-not-allowed"
                    : "text-gray hover:text-gray-light"
              )}
              title={disablePublic && output.mode !== "public" ? "Only 1 public output allowed" : undefined}
            >
              Public
            </button>
            <button
              onClick={() => !disableBtc && onUpdate({ mode: "btc", addressError: null, stealthError: null })}
              disabled={disableBtc && output.mode !== "btc"}
              className={cn(
                "px-2 py-1 rounded-[6px] text-[11px] font-medium transition-colors",
                output.mode === "btc"
                  ? "bg-btc/20 text-btc"
                  : disableBtc
                    ? "text-gray/30 cursor-not-allowed"
                    : "text-gray hover:text-gray-light"
              )}
              title={disableBtc && output.mode !== "btc" ? "Only 1 BTC/public output allowed" : undefined}
            >
              BTC
            </button>
          </div>
          {/* Remove */}
          {canRemove && (
            <button
              onClick={onRemove}
              className="p-1 rounded text-gray/50 hover:text-error transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Recipient */}
      {output.mode === "btc" ? (
        <div className="mb-2">
          <BtcAddressInput
            onValidated={(addr, script) => {
              onUpdate({ btcAddress: addr, btcScriptPubKey: script, btcAddressError: null });
            }}
            validatedAddress={output.btcAddress}
            error={output.btcAddressError}
            onError={(err) => onUpdate({ btcAddressError: err })}
          />
        </div>
      ) : output.mode === "note" ? (
        <div className="mb-2">
          <label className="text-caption text-gray pl-1 mb-1 block">
            Secret Phrase (share to let someone claim)
          </label>
          <div className="relative">
            <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-btc" />
            <input
              type="text"
              value={output.secretPhrase}
              onChange={(e) => onUpdate({ secretPhrase: e.target.value })}
              placeholder="e.g. alpha-bravo-charlie-1234"
              className={cn(
                "w-full px-3 py-2 pl-9 bg-muted border rounded-[8px]",
                "text-body2 font-mono text-foreground placeholder:text-gray/40",
                "outline-none transition-colors",
                output.secretPhrase.trim().length >= 8
                  ? "border-btc/30"
                  : "border-gray/20 focus:border-btc/40"
              )}
            />
          </div>
          {output.secretPhrase.trim().length > 0 && output.secretPhrase.trim().length < 8 && (
            <p className="text-[11px] text-gray mt-1 pl-1">
              Min 8 characters ({8 - output.secretPhrase.trim().length} more)
            </p>
          )}
        </div>
      ) : output.mode === "stealth" ? (
        <div className="mb-2">
          <StealthRecipientInput
            onResolved={(meta, name) =>
              onUpdate({ resolvedMeta: meta, resolvedName: name })
            }
            resolvedMeta={output.resolvedMeta}
            resolvedName={output.resolvedName}
            error={output.stealthError}
            onError={(err) => onUpdate({ stealthError: err })}
          />
        </div>
      ) : (
        <div className="mb-2">
          {isEditingAddress ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={output.solanaAddress}
                onChange={(e) => onUpdate({ solanaAddress: e.target.value, addressError: null })}
                placeholder="Solana address..."
                className={cn(
                  "flex-1 px-3 py-2 bg-muted border rounded-[8px]",
                  "text-caption font-mono text-gray-light placeholder:text-gray/40",
                  "outline-none transition-colors",
                  output.addressError ? "border-error/50" : "border-gray/20 focus:border-purple/40"
                )}
              />
              <button
                onClick={() => {
                  if (isValidSolanaAddress(output.solanaAddress)) {
                    setIsEditingAddress(false);
                  } else {
                    onUpdate({ addressError: "Invalid address" });
                  }
                }}
                className="p-1.5 rounded-[6px] bg-privacy/10 hover:bg-privacy/20 text-privacy transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  onUpdate({ solanaAddress: defaultAddress, addressError: null });
                  setIsEditingAddress(false);
                }}
                className="p-1.5 rounded-[6px] bg-gray/10 hover:bg-gray/20 text-gray transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div
              onClick={() => setIsEditingAddress(true)}
              className={cn(
                "flex items-center gap-2 p-2 rounded-[8px] cursor-pointer transition-colors",
                "bg-muted border",
                isOwnWallet ? "border-privacy/20 hover:border-privacy/40" : "border-purple/20 hover:border-purple/40"
              )}
            >
              <div className={cn("w-1.5 h-1.5 rounded-full", isOwnWallet ? "bg-privacy" : "bg-purple")} />
              <span className="flex-1 text-caption font-mono text-gray-light truncate">
                {output.solanaAddress ? truncateMiddle(output.solanaAddress, 6) : "Click to set address"}
              </span>
              <Pencil className="w-3 h-3 text-gray" />
            </div>
          )}
          {output.addressError && (
            <p className="text-[11px] text-error mt-1 pl-1">{output.addressError}</p>
          )}
        </div>
      )}

      {/* Amount */}
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={output.amount}
          onChange={(e) => onUpdate({ amount: e.target.value })}
          placeholder="0"
          min="0"
          className={cn(
            "flex-1 px-3 py-2 bg-muted border border-gray/20 rounded-[8px]",
            "text-body2 font-mono text-foreground placeholder:text-gray",
            "outline-none focus:border-purple/40 transition-colors",
            "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          )}
        />
        <span className="text-caption text-gray shrink-0">sats</span>
      </div>
    </div>
  );
}
