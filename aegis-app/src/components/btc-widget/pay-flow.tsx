"use client";

/**
 * PayFlow — main JoinSplit transaction UI component.
 *
 * Handles 4 payment modes:
 * - Private (stealth): sender → recipient via one-time stealth address
 * - Link (note): creates claimable note with secret phrase
 * - Solana (public/unshield): zkBTC → SPL token to Solana address
 * - Bitcoin (BTC redeem): zkBTC → BTC via FROST threshold signing
 *
 * Sub-components extracted to pay-flow/ directory:
 * - helpers.ts: Constants, types, validation, field reduction
 * - proving-steps.tsx: ZK proof generation progress indicator
 * - note-links.tsx: Claim link preview and shareable link
 * - output-row-card.tsx: Single output row with mode selector
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  CheckCircle2, Send, Wallet, Shield, Clock, AlertCircle, AlertTriangle,
  Key, Check, X, Loader2, Zap, Plus, Bitcoin,
  Download, Search, ChevronRight, ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseSats } from "@/lib/utils/validation";
import { formatBtc, formatAmount, truncateMiddle } from "@/lib/utils/formatting";
import { useAegis, type InboxNote } from "@/hooks/use-aegis";
import { usePasskey } from "@/hooks/use-passkey";
import { useAegisStore } from "@/stores/aegis-store";
import { AuthModal } from "@/components/auth-modal";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useProver } from "@/hooks/use-prover";
import {
  initPoseidon,
  prepareClaimInputs,
  getConfig,
  deriveMasterKey,
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
  ZKBTC_MINT_ADDRESS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
  deriveRedemptionRequestPDA,
  getTokenAccountAddress,
} from "@/lib/solana/instructions";
import { scanSecretPhrase, type ScannedSecretNote } from "@/lib/claim-utils";
import { setActiveToken } from "@/lib/token-context";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";

// Extracted sub-components
import {
  MIN_PAY_SATS, ZKBTC_TOKEN_ID, MAX_OUTPUTS, SERVICE_FEE_SATS, RELAYER_FEE_SATS,
  SOLANA_MAX_TX_SIZE, AVAILABLE_CIRCUITS, PAY_TOKENS,
  isValidSolanaAddress, reduceToFieldOnChain, estimateTransactionSize,
  autoSelectNotes, createOutputRow,
  type PayStep, type OutputMode, type OutputRow, type PayToken,
} from "./pay-flow/helpers";
import { ProvingSubSteps } from "./pay-flow/proving-steps";
import { NoteClaimLink } from "./pay-flow/note-links";
import { OutputRowCard } from "./pay-flow/output-row-card";

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
  const { setVisible: setWalletModalVisible } = useWalletModal();

  // Auth modal (passkey + wallet)
  const {
    isSupported: passkeySupported,
    hasCredential: hasPasskeyCredential,
    isLoading: passkeyLoading,
    error: passkeyError,
    register: registerPasskey,
    authenticate: authenticatePasskey,
  } = usePasskey();
  const deriveKeysFromPasskeySeed = useAegisStore((s) => s.deriveKeysFromPasskeySeed);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const handlePasskeyRegister = async () => {
    const seed = await registerPasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  const handlePasskeyAuthenticate = async () => {
    const seed = await authenticatePasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  // Auto-open auth modal when no keys
  const authAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (!hasKeys && !authAutoOpenedRef.current) {
      authAutoOpenedRef.current = true;
      setAuthModalOpen(true);
    }
    if (hasKeys) authAutoOpenedRef.current = false;
  }, [hasKeys]);

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

  // Token selector
  const [selectedToken, setSelectedToken] = useState<PayToken>(PAY_TOKENS[0]);
  const [showTokenPicker, setShowTokenPicker] = useState(false);

  // Sync active token context when selectedToken changes (for ZKBTC_TOKEN_ID())
  useEffect(() => {
    if (selectedToken.mint) {
      setActiveToken(selectedToken.mint);
    }
  }, [selectedToken.mint]);

  // Imported note from secret phrase
  const [showImportInput, setShowImportInput] = useState(!!initialSecretPhrase);
  const [importPhrase, setImportPhrase] = useState(initialSecretPhrase || "");
  const [importedNotes, setImportedNotes] = useState<ScannedSecretNote[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importAutoTriggered = useRef(false);

  // Relayer config (stealth meta + relayer fee from backend, service fees from on-chain)
  const [relayerMeta, setRelayerMeta] = useState<{
    stealthMeta: string | null;
    relayerFeeSats: number;
    serviceFeeSats: number;
    serviceFeeBps: number;
  } | null>(null);

  useEffect(() => {
    // Fetch service fees directly from on-chain pool state (no backend dependency)
    // and relayer config from backend in parallel
    Promise.all([
      fetch("/api/solana/pool-state").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/relayer/meta").then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([poolData, relayerData]) => {
      const state = poolData?.state;
      setRelayerMeta({
        stealthMeta: relayerData?.stealth_meta || null,
        relayerFeeSats: relayerData?.relayer_fee_sats ?? RELAYER_FEE_SATS,
        serviceFeeSats: state ? Number(state.serviceFeeBase) : SERVICE_FEE_SATS,
        serviceFeeBps: state?.serviceFeeBps ?? 0,
      });
    });
  }, []);

  // Output rows state — default first output based on initialMode
  const defaultOutputMode: OutputMode = initialMode === "btc_withdraw" ? "btc" : (initialMode === "public" ? "public" : "stealth");
  const [outputs, setOutputs] = useState<OutputRow[]>([
    createOutputRow(defaultOutputMode),
  ]);

  const isPurePrivateSend = !outputs.some(o => o.mode === "btc" || o.mode === "public");
  // Use 0 until relayer meta is fetched to avoid flash from default → actual value
  const relayerMetaLoaded = relayerMeta !== null;
  const effectiveRelayerFee = relayerMeta?.relayerFeeSats ?? 0;
  const effectiveServiceFee = relayerMeta?.serviceFeeSats ?? 0;
  const effectiveServiceFeeBps = relayerMeta?.serviceFeeBps ?? 0;

  // Token-aware amount formatter (replaces hardcoded BTC formatting)
  const fmt = (raw: number): string => formatAmount(raw, selectedToken.decimals);

  // Available unspent notes — filtered by selected token
  const availableNotes = useMemo(() => {
    return inboxNotes.filter((n) => n.amount > 0n && !n.isSpent && n.tokenSymbol === selectedToken.shieldedSymbol);
  }, [inboxNotes, selectedToken.shieldedSymbol]);

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

  // Total output sats (sum of all output amounts + relayer fee when enabled)
  const totalOutputSats = useMemo(() => {
    const userOutputs = outputs.reduce((sum, o) => {
      const sats = parseSats(o.amount);
      return sum + (sats ?? 0);
    }, 0);
    // Relayer fee is an extra output note — must be included in total for ALL modes
    return userOutputs + effectiveRelayerFee;
  }, [outputs, effectiveRelayerFee]);

  // Change = input - output
  const changeSats = totalInputSats - totalOutputSats;

  // Derived flags
  const hasBtcOutput = outputs.some(o => o.mode === "btc");
  const hasPublicOutput = outputs.some(o => o.mode === "public");

  // Circuit shape
  const nInputs = hasImportedNotes ? activeImportedNotes.length : selectedNotes.length;
  const nOutputs = outputs.length + (changeSats > 0 ? 1 : 0) + (effectiveRelayerFee > 0 ? 1 : 0); // +1 for change, +1 for relayer fee

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
      if (hasKeys) {
        setStep("compose");
      }
    }
  }, [preselectedNote, availableNotes, inboxLoading, hasKeys]);

  // Auto-select notes when total output changes
  useEffect(() => {
    if (notePreselectedRef.current) return; // Don't auto-select if user pre-selected
    if (totalOutputSats > 0 && availableNotes.length > 0) {
      setSelectedNoteIds(autoSelectNotes(availableNotes, totalOutputSats));
    }
  }, [totalOutputSats, availableNotes]);

  // Step transitions
  useEffect(() => {
    if (hasKeys && step === "connect") {
      setStep("compose");
    } else if (!hasKeys && step !== "connect") {
      setStep("connect");
    }
  }, [hasKeys, step]);

  // Auto-import note from ?note= URL param
  useEffect(() => {
    if (!initialSecretPhrase || importAutoTriggered.current || !hasKeys) return;
    importAutoTriggered.current = true;
    handleImportScan(initialSecretPhrase);
  }, [initialSecretPhrase, hasKeys]);

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
    if (!relayerMetaLoaded) errors.push("Loading fee configuration...");

    // For public redeem, no shielded notes needed
    const hasBtcOut = outputs.some(o => o.mode === "btc");
    const canPublicRedeem = hasBtcOut && selectedNotes.length === 0 && !hasImportedNotes && publicZkbtcBalance > 0n;
    if (!canPublicRedeem && !hasImportedNotes && selectedNotes.length === 0) errors.push("Select at least one note to send");
    if (outputs.length === 0) errors.push("Add at least one recipient");

    for (const o of outputs) {
      const sats = parseSats(o.amount);
      if (!sats || sats < MIN_PAY_SATS) {
        errors.push(`Each output must be at least ${fmt(MIN_PAY_SATS)} ${selectedToken.shieldedSymbol}`);
        break;
      }
      // BTC withdrawal must cover service fee + dust + estimated miner fee
      if (o.mode === "btc" && sats <= effectiveServiceFee + 546 + 1000) {
        errors.push(`BTC withdrawal must be at least ${fmt(effectiveServiceFee + 546 + 1000)} ${selectedToken.shieldedSymbol} (fee + dust + miner fee)`);
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

      // Check circuit availability
      if (nInputs > 0 && nOutputs > 0) {
        const circuitKey = `${nInputs}x${nOutputs}`;
        if (!AVAILABLE_CIRCUITS.has(circuitKey)) {
          errors.push(`Circuit JoinSplit(${circuitKey}) not supported (max N+M=14)`);
        }
      }

      // Check Solana transaction size limit
      if (nInputs > 0 && nOutputs > 0) {
        const estimatedSize = estimateTransactionSize(nInputs, nOutputs);
        if (estimatedSize > SOLANA_MAX_TX_SIZE) {
          errors.push(`Transaction too large (${estimatedSize}/${SOLANA_MAX_TX_SIZE} bytes). Reduce inputs or outputs.`);
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
    if (!hasImportedNotes && !isPublicRedeem && (!keys || !canSubmit)) return;
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
        // Public redeem removed in multi-token version — use request_redemption
        const { buildRedemptionRequestInstructionData } = await import("@aegis/sdk");

        const [poolState] = derivePoolStatePDA();
        const [commitmentTree] = deriveCommitmentTreePDA();
        const [redemptionRequest] = deriveRedemptionRequestPDA(publicKey!, requestNonce);
        const nullifierHash = new Uint8Array(32); // demo mode
        const [nullifierPDA] = deriveNullifierPDA(nullifierHash);
        const [tokenConfig] = PublicKey.findProgramAddressSync(
          [Buffer.from("token_config"), ZKBTC_MINT_ADDRESS.toBuffer()],
          AEGIS_PROGRAM_ID,
        );

        const ixData = buildRedemptionRequestInstructionData({
          proofHash: new Uint8Array(32),
          merkleRoot: new Uint8Array(32),
          nullifierHash,
          amountSats,
          vkHash: new Uint8Array(32),
          btcScript: btcOut.btcScriptPubKey!,
          requestNonce: BigInt(requestNonce.toString()),
        });

        const publicRedeemIx = new TransactionInstruction({
          programId: AEGIS_PROGRAM_ID,
          keys: [
            { pubkey: poolState, isSigner: false, isWritable: true },
            { pubkey: commitmentTree, isSigner: false, isWritable: false },
            { pubkey: nullifierPDA, isSigner: false, isWritable: true },
            { pubkey: redemptionRequest, isSigner: false, isWritable: true },
            { pubkey: publicKey!, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: tokenConfig, isSigner: false, isWritable: true },
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
        // Auto-refresh after public redeem
        for (const delay of [2000, 5000, 10000]) {
          setTimeout(() => {
            refreshInbox(undefined, true);
            refreshPublicBalance?.(publicKey!);
          }, delay);
        }
        return;
      }

      // ===== ZK PROOF PATH =====
      // Validate circuit availability before anything else
      const effectiveNInputs = hasImportedNotes ? activeImportedNotes.length : selectedNotes.length;
      const circuitKey = `${effectiveNInputs}x${outputs.length + (changeSats > 0 ? 1 : 0) + (effectiveRelayerFee > 0 ? 1 : 0)}`;
      if (!AVAILABLE_CIRCUITS.has(circuitKey)) {
        throw new Error(
          `Circuit JoinSplit(${circuitKey}) is not supported (N+M must be ≤ 14). ` +
          `Adjust your inputs/outputs to fit.`
        );
      }

      await initPoseidon();

      const { computeJoinSplitCommitmentSync, createStealthDepositWithKeys,
              eddsaPoseidonSign, computeBoundParamsHash, DEFAULT_BOUND_PARAMS,
              createUnshieldBoundParams, poseidonHashSync,
              getCommitmentIndex: getCommitmentIndexSdk,
              hexToBytes: sdkHexToBytes,
              decodeStealthMetaAddress } = await import("@aegis/sdk");

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
        setProofStatus("Verifying imported funds...");

        // Fetch all announcements once
        const announcementsResp = await fetch("/api/announcements");
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
            announcementType: matchingAnn.announcement_type,
            ephemeralPub: hexToBytes(matchingAnn.ephemeral_pub),
            encryptedAmount: hexToBytes(matchingAnn.encrypted_amount),
            commitment: hexToBytes(matchingAnn.commitment),
            leafIndex: matchingAnn.leaf_index,
          }];

          const scanned = await scanNotes(impNote.keys, parsedAnns, ZKBTC_TOKEN_ID());
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
        setProofStatus("Verifying your funds...");

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
        setProofStatus("Preparing private transfer...");

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
              claimInputs.npk, ZKBTC_TOKEN_ID(), scannedNote.amount
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
      setProofStatus("Building transaction...");

      const selfMeta = stealthAddress ?? null;

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
          const result = await createStealthDepositWithKeys(selfMeta, amount, ZKBTC_TOKEN_ID());
          recipientNpks.push(result.stealthPubKeyX);
          // Dummy stealth result — redeem output has no announcement (sliced off like unshield)
          stealthResults.push({
            ephemeralPub: new Uint8Array(32),
            encryptedAmount: new Uint8Array(8),
            stealthPubKeyX: result.stealthPubKeyX,
          } as Awaited<ReturnType<typeof createStealthDepositWithKeys>>);
        } else if (output.mode === "public") {
          // Unshield output: use Solana recipient address as "npk"
          // On-chain expects: commitment = Poseidon(reduce_to_field(solana_address), ZKBTC_TOKEN_ID, amount)
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
          const result = await createStealthDepositWithKeys(noteMeta, amount, ZKBTC_TOKEN_ID());
          recipientNpks.push(result.stealthPubKeyX);
          stealthResults.push(result);
        } else if (output.mode === "stealth" && output.resolvedMeta) {
          // Stealth output: single call provides BOTH npk AND stealth data
          const result = await createStealthDepositWithKeys(output.resolvedMeta, amount, ZKBTC_TOKEN_ID());
          recipientNpks.push(result.stealthPubKeyX);
          stealthResults.push(result);
        } else {
          // Self output: create stealth deposit to self for scannable notes
          if (!selfMeta) throw new Error("Cannot create output without stealth address");
          const result = await createStealthDepositWithKeys(selfMeta, amount, ZKBTC_TOKEN_ID());
          recipientNpks.push(result.stealthPubKeyX);
          stealthResults.push(result);
        }
      }

      // Add relayer fee output (always — fee goes to relayer if stealthMeta available, else to self)
      let relayerFeeOutputIndex: number | undefined;
      if (effectiveRelayerFee > 0) {
        setProofStatus("Adding relayer fee output...");
        const feeAmount = BigInt(effectiveRelayerFee);
        // Use relayer stealth meta if available, otherwise send fee to self
        const feeMeta = relayerMeta?.stealthMeta
          ? decodeStealthMetaAddress(relayerMeta.stealthMeta)
          : selfMeta;
        if (!feeMeta) throw new Error("Cannot create fee output without stealth address");
        const feeResult = await createStealthDepositWithKeys(feeMeta, feeAmount, ZKBTC_TOKEN_ID());
        if (hasSpecialLastOutput) {
          // Insert BEFORE the unshield/redeem output (which is currently last)
          const insertIdx = sendAmounts.length - 1;
          relayerFeeOutputIndex = insertIdx;
          sendAmounts.splice(insertIdx, 0, feeAmount);
          recipientNpks.splice(insertIdx, 0, feeResult.stealthPubKeyX);
          stealthResults.splice(insertIdx, 0, feeResult);
        } else {
          relayerFeeOutputIndex = sendAmounts.length;
          sendAmounts.push(feeAmount);
          recipientNpks.push(feeResult.stealthPubKeyX);
          stealthResults.push(feeResult);
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

        const changeResult = await createStealthDepositWithKeys(changeMeta!, changeAmount, ZKBTC_TOKEN_ID());

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
        computeJoinSplitCommitmentSync(npk, ZKBTC_TOKEN_ID(), sendAmounts[i])
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
      setProofStatus("Generating privacy proof...");

      if (!prover.isInitialized) {
        await prover.initialize();
      }

      const actualNOutputs = sendAmounts.length;

      const joinsplitInputs: JoinSplitProofInputs = {
        nInputs: effectiveNInputs,
        nOutputs: actualNOutputs,
        merkleRoot,
        boundParamsHash,
        token: ZKBTC_TOKEN_ID(),
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

      const { proof: proofData, proofBytes } = await prover.generateProof(joinsplitInputs);

      // 7. Build stealth data and submit
      setProofStatus("Submitting transaction...");

      const stealthDataArrays: Uint8Array[] = stealthResults.map((result) => {
        const sd = new Uint8Array(40);
        sd.set(result.ephemeralPub, 0);
        sd.set(result.encryptedAmount, 32);
        return sd;
      });

      // Use publicSignals from snarkjs (guaranteed to match the proof)
      // Order: [merkleRoot, boundParamsHash, nullifiers[0..N], commitmentsOut[0..M]]
      const publicSignals = proofData.publicInputs;
      const merkleRootHex = BigInt(publicSignals[0]).toString(16).padStart(64, "0");
      const boundParamsHashHex = BigInt(publicSignals[1]).toString(16).padStart(64, "0");
      const nullifierHexes = publicSignals.slice(2, 2 + effectiveNInputs).map(
        (s: string) => BigInt(s).toString(16).padStart(64, "0")
      );
      const commitmentHexes = publicSignals.slice(2 + effectiveNInputs, 2 + effectiveNInputs + actualNOutputs).map(
        (s: string) => BigInt(s).toString(16).padStart(64, "0")
      );

      // Debug: compare snarkjs public signals with client-computed values
      const clientMerkleRootHex = merkleRoot.toString(16).padStart(64, "0");
      const clientBoundParamsHex = boundParamsHash.toString(16).padStart(64, "0");
      const clientNullifierHexes = allNullifiers.map((n) => n.toString(16).padStart(64, "0"));
      const clientCommitmentHexes = outCommitments.map((c) => c.toString(16).padStart(64, "0"));
      if (merkleRootHex !== clientMerkleRootHex) console.warn("[Pay] MISMATCH merkleRoot:", { snarkjs: merkleRootHex, client: clientMerkleRootHex });
      if (boundParamsHashHex !== clientBoundParamsHex) console.warn("[Pay] MISMATCH boundParamsHash:", { snarkjs: boundParamsHashHex, client: clientBoundParamsHex });
      nullifierHexes.forEach((h, i) => { if (h !== clientNullifierHexes[i]) console.warn(`[Pay] MISMATCH nullifier[${i}]:`, { snarkjs: h, client: clientNullifierHexes[i] }); });
      commitmentHexes.forEach((h, i) => { if (h !== clientCommitmentHexes[i]) console.warn(`[Pay] MISMATCH commitment[${i}]:`, { snarkjs: h, client: clientCommitmentHexes[i] }); });

      let relayResult: { success: boolean; signature?: string; error?: string };

      if (isBtcRedeem && btcOutput) {
        // BTC Redeem: submit via relayer API (same as transact/unshield)
        const redeemAmountSats = BigInt(parseSats(btcOutput.amount) ?? 0);
        const requestNonce = BigInt(Date.now());

        // Tree stealth data = all except the last (redeem output)
        const treeStealthData = stealthDataArrays.slice(0, -1);

        const redeemResponse = await fetch("/api/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nInputs: effectiveNInputs,
            nOutputs: actualNOutputs,
            proof: bytesToHex(proofBytes),
            merkleRoot: merkleRootHex,
            boundParamsHash: boundParamsHashHex,
            nullifiers: nullifierHexes,
            commitmentsOut: commitmentHexes,
            stealthData: treeStealthData.map((sd) => bytesToHex(sd)),
            redeemAmount: redeemAmountSats.toString(),
            btcScript: bytesToHex(btcOutput.btcScriptPubKey!),
            requestNonce: requestNonce.toString(),
          }),
        });

        relayResult = await redeemResponse.json();
      } else if (isPublicUnshield && unshieldRecipientAddress) {
        // Public unshield: call /api/unshield
        // The unshield output is the LAST commitment — stealth data is only for tree outputs (all except last)
        const unshieldAmount = parseSats(publicOutput!.amount) ?? 0;

        // Get or create associated token account for recipient
        const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
        const recipientPubkey = new PublicKey(publicOutput!.solanaAddress);
        const zkbtcMint = new PublicKey(getConfig().zkbtcMint);
        const TOKEN_2022_PID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        const recipientTokenAccount = getAssociatedTokenAddressSync(
          zkbtcMint, recipientPubkey, false, TOKEN_2022_PID
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
            boundParamsHash: boundParamsHashHex,
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
            boundParamsHash: boundParamsHashHex,
            nullifiers: nullifierHexes,
            commitmentsOut: commitmentHexes,
            stealthData: stealthDataArrays.map((sd) => bytesToHex(sd)),
            relayerFeeOutputIndex,
          }),
        });

        relayResult = await relayResponse.json();
      }

      if (!relayResult.success) {
        const logs = 'logs' in relayResult ? relayResult.logs : undefined;
        if (logs) console.error("[Pay] Program logs:", logs);
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

      // Auto-refresh balances after successful transaction (force=true to bypass dedup cache)
      // Retry with increasing delay to give backend time to index
      for (const delay of [2000, 5000, 10000]) {
        setTimeout(() => {
          refreshInbox(undefined, true);
          if (publicKey) refreshPublicBalance?.(publicKey);
        }, delay);
      }
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
    if (!hasKeys) {
      return (
        <>
          <div className="flex flex-col items-center justify-center py-8">
            <div className="rounded-full bg-privacy/10 p-4 mb-4">
              <Shield className="h-10 w-10 text-privacy" />
            </div>
            <p className="text-body2 text-gray text-center mb-4">
              Unlock your vault to send and receive private Bitcoin
            </p>
            <button
              onClick={() => setAuthModalOpen(true)}
              className={cn(
                "inline-flex items-center gap-2 px-6 py-3 rounded-[12px]",
                "bg-privacy hover:bg-privacy/80",
                "text-body2 text-background font-medium transition-all duration-200 cursor-pointer",
                "hover:shadow-[0_0_24px_rgba(20,241,149,0.2)]"
              )}
            >
              <Key className="w-4 h-4" />
              Unlock Vault
            </button>
          </div>
          <AuthModal
            open={authModalOpen}
            onOpenChange={setAuthModalOpen}
            passkeySupported={passkeySupported}
            hasPasskeyCredential={hasPasskeyCredential}
            passkeyLoading={passkeyLoading}
            walletLoading={keysLoading}
            walletConnected={connected}
            error={passkeyError}
            onPasskeyRegister={handlePasskeyRegister}
            onPasskeyAuthenticate={handlePasskeyAuthenticate}
            onWalletConnect={() => { setAuthModalOpen(false); setWalletModalVisible(true); }}
            onWalletDeriveKeys={async () => { await deriveKeys(); setAuthModalOpen(false); }}
          />
        </>
      );
    }

    if (hasKeys && availableNotes.length === 0) {
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

    return null;
  }

  // ===== COMPOSE STEP =====
  if (step === "compose") {
    return (
      <div className="flex flex-col text-start">
        {/* === SEND SECTION === */}
        <div className="mb-4">
          <p className="text-body2-semibold text-gray-light uppercase tracking-wider text-xs mb-2">
            Send
          </p>

          {/* Amount display + Token selector (like reference) */}
          <div className="flex items-center gap-3 p-3 rounded-[10px] bg-muted border border-gray/15 mb-2">
            <span className="flex-1 text-xl font-semibold text-foreground tabular-nums">
              {totalOutputSats > 0 ? fmt(totalOutputSats) : "0"}
            </span>
            <div className="relative">
              <button
                onClick={() => setShowTokenPicker(!showTokenPicker)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-background/60 hover:bg-background/80 border border-gray/15 transition-colors"
              >
                <img src={selectedToken.shieldedLogo} alt={selectedToken.shieldedSymbol} className="w-4 h-4 rounded-full" />
                <span className="text-sm font-medium text-foreground">{selectedToken.shieldedSymbol}</span>
                <ChevronRight className={cn("w-3 h-3 text-gray transition-transform", showTokenPicker && "rotate-90")} />
              </button>
              {showTokenPicker && (
                <div className="absolute top-full right-0 mt-1 z-[100] w-[160px] py-1 bg-card border border-gray/20 rounded-[10px] shadow-xl">
                  {PAY_TOKENS.map((token) => (
                    <button
                      key={token.symbol}
                      disabled={!token.enabled}
                      onClick={() => {
                        if (token.enabled) {
                          setSelectedToken(token);
                          setShowTokenPicker(false);
                        }
                      }}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors text-left cursor-pointer",
                        token.symbol === selectedToken.symbol
                          ? "bg-purple/10 text-foreground"
                          : token.enabled
                            ? "text-gray-light hover:bg-muted hover:text-foreground"
                            : "text-gray/30 cursor-not-allowed"
                      )}
                    >
                      <img src={token.shieldedLogo} alt={token.shieldedSymbol} className={cn("w-4 h-4 rounded-full", !token.enabled && "opacity-30")} />
                      <span className="font-medium flex-1">{token.shieldedSymbol}</span>
                      {!token.enabled && (
                        <span className="text-[9px] text-gray/40 uppercase">Soon</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Private balance + Top Up */}
          <div className="flex items-center justify-between px-1 mb-3">
            <span className="text-[12px] text-gray">
              Private balance: {fmt(availableNotes.reduce((sum, n) => sum + Number(n.amount), 0))} {selectedToken.shieldedSymbol}
            </span>
            <div className="flex items-center gap-2">
              <a
                href="/vault/deposit"
                className="text-[12px] text-gray hover:text-purple border border-gray/20 hover:border-purple/30 rounded-full px-2.5 py-0.5 transition-colors"
              >
                + Top Up
              </a>
              {!hasImportedNotes && !(initialSecretPhrase && (importLoading || importError)) && (
                <button
                  onClick={() => setShowNoteSelector(!showNoteSelector)}
                  className="text-[12px] text-gray hover:text-purple transition-colors"
                >
                  {showNoteSelector ? "Done" : selectedNotes.length > 0
                    ? `${selectedNotes.length} note${selectedNotes.length !== 1 ? "s" : ""} ›`
                    : "Select notes"}
                </button>
              )}
            </div>
          </div>

          {hasImportedNotes ? null : initialSecretPhrase && !hasImportedNotes && (importLoading || importError) ? (
            /* When coming from ?note= link and scan failed or loading */
            importLoading ? (
              <div className="p-3 rounded-[10px] bg-muted border border-gray/15 text-center mb-2">
                <Loader2 className="w-4 h-4 animate-spin text-btc mx-auto mb-1" />
                <p className="text-caption text-gray">Scanning secret phrase...</p>
              </div>
            ) : (
              <div className="p-3 rounded-[10px] bg-error/5 border border-error/20 text-center mb-2">
                <p className="text-body2 text-error mb-1">No notes found</p>
                <p className="text-caption text-gray">{importError}</p>
                <button
                  onClick={clearImportedNote}
                  className="mt-2 text-caption text-purple hover:text-purple/80 underline transition-colors"
                >
                  Use wallet notes instead
                </button>
              </div>
            )
          ) : showNoteSelector ? (
            /* Expanded note selector (pro user) */
            <div className="space-y-1.5 mb-2">
              {availableNotes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => toggleNoteSelection(note.id)}
                  className={cn(
                    "w-full flex items-center gap-3 p-2.5 rounded-[10px] text-left transition-all border",
                    selectedNoteIds.has(note.id)
                      ? "bg-purple/10 border-purple/30"
                      : "bg-muted border-gray/15 hover:border-gray/30"
                  )}
                >
                  <div className={cn(
                    "w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors",
                    selectedNoteIds.has(note.id) ? "bg-purple border-purple" : "border-gray/30"
                  )}>
                    {selectedNoteIds.has(note.id) && <Check className="w-2.5 h-2.5 text-white" />}
                  </div>
                  <div className="flex-1 flex justify-between items-center">
                    <span className="text-body2-semibold text-foreground">
                      {fmt(Number(note.amount))} {selectedToken.shieldedSymbol}
                    </span>
                    <span className="text-caption text-gray font-mono">leaf #{note.leafIndex}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : null /* Notes auto-selected — no UI needed in default mode */}

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
                      {fmt(impNote.amount)} {selectedToken.shieldedSymbol}
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
              <div className="mb-2 flex justify-end px-1">
                <button
                  onClick={() => setShowImportInput(true)}
                  className="text-[11px] text-gray hover:text-btc transition-colors flex items-center gap-1"
                >
                  Import from Secret
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            )
          )}

          {/* Disable inbox note selector when imported notes are active */}
          {hasImportedNotes && selectedNotes.length > 0 && (
            <p className="text-[11px] text-gray mb-2 pl-1">
              Inbox notes disabled while using imported notes
            </p>
          )}

          {/* Public redeem balance note */}
          {isPublicRedeem && (
            <div className="flex justify-between items-center px-2 text-body2 mb-1">
              <span className="text-gray">Public {selectedToken.shieldedSymbol} Balance</span>
              <span className="text-foreground font-semibold">
                {fmt(Number(publicZkbtcBalance))} {selectedToken.shieldedSymbol}
              </span>
            </div>
          )}
        </div>

        <div className="border-t border-gray/10 my-2" />

        {/* === RECIPIENTS SECTION === */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-body2-semibold text-gray-light uppercase tracking-wider text-xs">
              Recipients
            </p>
            {outputs.length < MAX_OUTPUTS && (
              <button
                onClick={addOutput}
                className="flex items-center gap-1 text-caption text-purple hover:text-purple/80 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add Recipient
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
                defaultAddress={keys?.solanaPublicKey.some(b => b !== 0) ? (publicKey?.toBase58() || "") : ""}
                disablePublic={outputs.some(o => o.id !== output.id && (o.mode === "public" || o.mode === "btc"))}
                disableBtc={outputs.some(o => o.id !== output.id && (o.mode === "public" || o.mode === "btc"))}
                selfMeta={stealthAddress ?? null}
                maxAmount={Math.max(0, totalInputSats - outputs.reduce((sum, o, j) => j === index ? sum : sum + (parseSats(o.amount) ?? 0), 0) - effectiveRelayerFee)}
                serviceFeeSats={effectiveServiceFee}
                serviceFeeBps={effectiveServiceFeeBps}
                tokenUnit={selectedToken.unit}
                tokenSymbol={selectedToken.shieldedSymbol}
              />
            ))}
          </div>

          {/* Privacy info: public/BTC outputs reduce privacy */}
          {(hasPublicOutput || hasBtcOutput) && (
            <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-[10px] bg-btc/5 border border-btc/20">
              <AlertTriangle className="w-4 h-4 text-btc shrink-0 mt-0.5" />
              <p className="text-caption text-btc">
                {hasPublicOutput
                  ? "Public output reveals your Solana address on-chain."
                  : "BTC output reveals your Bitcoin withdrawal address on-chain."}
              </p>
            </div>
          )}
        </div>

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
                <span className="text-gray-light font-semibold">
                  {fmt(outputs.filter(o => o.mode === "stealth" || o.mode === "note").reduce((s, o) => s + (parseSats(o.amount) ?? 0), 0))} {selectedToken.shieldedSymbol}
                </span>
              </div>
              {hasPublicOutput && (
                <div className="flex justify-between items-center text-body2 mb-1">
                  <span className="text-gray flex items-center gap-1.5">
                    <Wallet className="w-3.5 h-3.5 text-privacy" /> Unshield
                  </span>
                  <span className="text-gray-light font-semibold">
                    {fmt(outputs.filter(o => o.mode === "public").reduce((s, o) => s + (parseSats(o.amount) ?? 0), 0))} {selectedToken.shieldedSymbol}
                  </span>
                </div>
              )}
              {hasBtcOutput && (() => {
                const btcTotalSats = outputs.filter(o => o.mode === "btc").reduce((s, o) => s + (parseSats(o.amount) ?? 0), 0);
                const percentFee = Math.ceil(btcTotalSats * 0.003);
                const totalFee = effectiveServiceFee + percentFee;
                const userReceives = Math.max(0, btcTotalSats - totalFee);
                return (
                  <>
                    <div className="flex justify-between items-center text-body2 mb-1">
                      <span className="text-gray flex items-center gap-1.5">
                        <Bitcoin className="w-3.5 h-3.5 text-btc" /> BTC Withdrawal
                      </span>
                      <span className="text-gray-light font-semibold">
                        {fmt(btcTotalSats)} {selectedToken.shieldedSymbol}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-caption mb-1 ml-5">
                      <span className="text-gray/80">You receive (after fees)</span>
                      <span className="text-gray/80 font-medium">{fmt(userReceives)} {selectedToken.shieldedSymbol}</span>
                    </div>
                  </>
                );
              })()}
              <div className="border-t border-gray/10 my-1" />
            </>
          )}
          <div className="flex justify-between items-center text-body2 mb-1">
            <span className="text-gray">
              {hasPublicOutput || hasBtcOutput ? "Total" : "Send Total"}
            </span>
            <span className="text-foreground font-semibold">
              {fmt(totalOutputSats)} {selectedToken.shieldedSymbol}
            </span>
          </div>
          {/* Relayer fee — paid as a shielded note to relayer */}
          {!isPublicRedeem && (
            <div className="flex justify-between items-center text-caption mb-1">
              <span className="text-gray/60">
                Relayer fee (shielded note → relayer)
              </span>
              <span className="text-gray/60">
                {relayerMetaLoaded ? fmt(effectiveRelayerFee) : "..."} {selectedToken.shieldedSymbol}
              </span>
            </div>
          )}
          {!isPublicRedeem && (
            <div className="flex justify-between items-center text-body2 mb-1">
              <span className="text-gray">{hasImportedNotes ? "Change (as Note)" : "Change (kept shielded)"}</span>
              <span className={cn(
                "font-semibold",
                changeSats >= 0 ? "text-gray-light" : "text-error"
              )}>
                {changeSats >= 0 ? fmt(changeSats) : "-" + fmt(-changeSats)} {selectedToken.shieldedSymbol}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center text-body2 pt-1 border-t border-gray/10">
            <span className="text-gray">Privacy</span>
            <span className={cn("font-mono text-xs", isPublicRedeem ? "text-btc" : "text-gray-light")}>
              {isPublicRedeem
                ? "Public (no proof)"
                : <>
                    ZK Proof
                    {hasPublicOutput && " + Unshield"}
                    {hasBtcOutput && " + BTC Withdraw"}
                  </>
              }
            </span>
          </div>
          {!isPublicRedeem && nInputs > 0 && nOutputs > 0 && (() => {
            const txSize = estimateTransactionSize(nInputs, nOutputs);
            const sizeOk = txSize <= SOLANA_MAX_TX_SIZE;
            return (
              <>
                <div className="flex justify-between items-center text-body2 mt-1">
                  <span className="text-gray">Circuit</span>
                  <span className={cn(
                    "font-mono text-xs",
                    AVAILABLE_CIRCUITS.has(`${nInputs}x${nOutputs}`)
                      ? "text-gray-light"
                      : "text-red-400"
                  )}>
                    JoinSplit({nInputs}x{nOutputs})
                    {!AVAILABLE_CIRCUITS.has(`${nInputs}x${nOutputs}`) && " — N/A"}
                  </span>
                </div>
                <div className="flex justify-between items-center text-body2 mt-1">
                  <span className="text-gray">Tx Size</span>
                  <span className={cn(
                    "font-mono text-xs",
                    sizeOk ? "text-gray-light" : "text-orange-400"
                  )}>
                    {txSize}/{SOLANA_MAX_TX_SIZE} bytes
                    {!sizeOk && " — too large"}
                  </span>
                </div>
              </>
            );
          })()}
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
          <div className={cn(
            "mb-4 p-2.5 rounded-[10px]",
            validationErrors[0].includes("too large")
              ? "bg-orange-500/10 border border-orange-500/20"
              : "bg-gray/5 border border-gray/10"
          )}>
            <p className={cn(
              "text-caption",
              validationErrors[0].includes("too large") ? "text-orange-400" : "text-gray"
            )}>{validationErrors[0]}</p>
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
              Redeem Public {selectedToken.shieldedSymbol} to BTC
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
        <div className={cn("rounded-full p-5 mb-5", successBtcOutput ? "bg-btc/10" : "bg-success/10")}>
          {successBtcOutput ? (
            <Bitcoin className="h-14 w-14 text-btc" />
          ) : (
            <CheckCircle2 className="h-14 w-14 text-success" />
          )}
        </div>

        <p className="text-heading6 text-foreground mb-1.5">
          {successBtcOutput ? "BTC Withdrawal Submitted!" : "Payment Complete!"}
        </p>
        <p className="text-body2 text-gray text-center mb-5">
          {successBtcOutput
            ? "Redemption request created on-chain. BTC will be sent to your address."
            : hasStealth
              ? "Stealth payment submitted on-chain"
              : `Your ${selectedToken.shieldedSymbol} has been sent successfully`}
        </p>

        <div className="w-full gradient-bg-card p-4 rounded-[12px] mb-4 space-y-3">
          <div className="flex justify-between items-center text-body2">
            <span className="text-gray">Transaction</span>
            <a
              href={getSolanaExplorerTxUrl(requestId)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-gray-light text-xs hover:text-foreground transition-colors flex items-center gap-1"
            >
              {truncateMiddle(requestId, 8)}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
          <div className="flex justify-between items-center text-body2">
            <span className="text-gray">Sent</span>
            <span className="text-foreground">{fmt(totalOutputSats)} {selectedToken.shieldedSymbol}</span>
          </div>
          {changeAmountSats > 0 && (
            <div className="flex justify-between items-center text-body2">
              <span className="text-gray">Change</span>
              <span className="text-foreground">{fmt(changeAmountSats)} {selectedToken.shieldedSymbol}</span>
            </div>
          )}
          {successBtcOutput && (
            <div className="flex justify-between items-center text-body2">
              <span className="text-gray">BTC Address</span>
              <span className="font-mono text-btc text-xs">
                {truncateMiddle(successBtcOutput.btcAddress || "", 8)}
              </span>
            </div>
          )}
          <div className="flex justify-between items-center text-body2 pt-2 border-t border-gray/15">
            <span className="text-gray">Privacy</span>
            <span className="font-mono text-success text-xs">ZK Proof</span>
          </div>
        </div>

        {/* Claim links for Note outputs */}
        {noteOutputPhrases.length > 0 && (
          <div className="w-full mb-4 space-y-2">
            <div className="flex items-center gap-3 p-3 bg-warning/10 border border-warning/25 rounded-[12px]">
              <AlertCircle className="w-5 h-5 text-warning shrink-0" />
              <p className="text-caption text-warning">
                Save these note links securely. They cannot be recovered if lost.
              </p>
            </div>
            {noteOutputPhrases.map((np, i) => (
              <NoteClaimLink key={i} phrase={np.phrase} amount={np.amount} tokenSymbol={selectedToken.shieldedSymbol} />
            ))}
          </div>
        )}

        <div className="w-full flex items-center gap-3 p-3 bg-muted border border-gray/15 rounded-[12px] mb-6">
          <CheckCircle2 className="w-5 h-5 text-gray shrink-0" />
          <p className="text-caption text-gray">
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

// OutputRowCard, NoteClaimLink, NoteLinkPreview, ProvingSubSteps extracted to pay-flow/ directory
