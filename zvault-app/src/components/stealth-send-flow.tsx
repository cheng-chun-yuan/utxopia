"use client";

import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  QrCode,
  Send,
  Wallet,
  Key,
  RefreshCw,
  User,
  Tag,
  Inbox,
  Loader2,
  ArrowRight,
  ArrowDownToLine,
} from "lucide-react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useZVaultKeys, useStealthInbox } from "@/hooks/use-zvault";
import { NoteSelector, type OwnedNote } from "./note-selector";
import {
  decodeStealthMetaAddress,
  createStealthDeposit,
  deriveTaprootAddress,
  lookupZkeyName,
  formatBtc,
  type StealthMetaAddress,
  type StealthDeposit,
} from "@zvault/sdk";

interface DepositData {
  taprootAddress: string;
  stealthDeposit: StealthDeposit;
  recipientAddress: string;
  amountSats: bigint;
}

interface TransferResult {
  signature: string;
  ephemeralPubKey: string;
  outputCommitment: string;
  amount: bigint;
}

export function StealthSendFlow() {
  const searchParams = useSearchParams();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const { keys, deriveKeys, isLoading: keysLoading } = useZVaultKeys();
  const { copied, copy } = useCopyToClipboard();
  const { notes: inboxNotes, totalAmountSats, depositCount, isLoading: inboxLoading, refresh: refreshInbox } = useStealthInbox();

  // Form state
  const [recipientInput, setRecipientInput] = useState("");
  const [selectedNote, setSelectedNote] = useState<OwnedNote | null>(null);

  // Process state
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferResult, setTransferResult] = useState<TransferResult | null>(null);
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);

  // Convert inbox notes to OwnedNote format
  const ownedNotes: OwnedNote[] = (inboxNotes || []).map((d, i) => ({
    id: d.id || (d.commitment ? Array.from(d.commitment).map(b => b.toString(16).padStart(2, '0')).join('') : `note-${i}`),
    amountSats: d.amount, // ScannedNote uses 'amount', not 'amountSats'
    commitment: d.commitmentHex || (d.commitment ? Array.from(d.commitment).map(b => b.toString(16).padStart(2, '0')).join('') : ''),
    leafIndex: d.leafIndex || i,
    status: "claimable" as const,
    createdAt: d.createdAt,
  }));

  // Pre-select note from URL params (when navigating from inbox)
  useEffect(() => {
    const noteId = searchParams.get("noteId");
    const commitment = searchParams.get("commitment");
    const amount = searchParams.get("amount");
    const leafIndex = searchParams.get("leafIndex");

    if (noteId && commitment && amount && leafIndex) {
      // Check if note exists in ownedNotes, otherwise create from params
      const existingNote = ownedNotes.find(n => n.commitment === commitment);
      if (existingNote) {
        setSelectedNote(existingNote);
      } else {
        // Create note from URL params
        const noteFromParams: OwnedNote = {
          id: noteId,
          amountSats: BigInt(amount),
          commitment,
          leafIndex: parseInt(leafIndex, 10),
          status: "claimable",
          createdAt: Date.now(),
        };
        setSelectedNote(noteFromParams);
      }
    }
  }, [searchParams, ownedNotes.length]); // Re-run when notes load

  // Resolve recipient - supports both zkey names and raw hex addresses
  const resolveRecipient = useCallback(async () => {
    const input = recipientInput.trim();
    if (!input) return;

    setResolving(true);
    setError(null);
    setResolvedMeta(null);
    setResolvedName(null);

    try {
      // Check if it looks like hex (long, only hex chars)
      const isLikelyHex = /^[0-9a-fA-F]{100,}$/.test(input);

      if (isLikelyHex) {
        // Try to decode as hex stealth address
        const meta = decodeStealthMetaAddress(input);
        if (meta) {
          setResolvedMeta(meta);
          return;
        }
        setError("Invalid stealth address format (expected 130 hex characters)");
      } else {
        // Try as .zkey.sol name (custom name registry)
        const name = input.replace(/\.zkey\.sol$/i, "").replace(/\.zkey$/i, "");
        const connectionAdapter = getConnectionAdapter();
        const result = await lookupZkeyName(connectionAdapter as any, name);
        if (result) {
          setResolvedMeta(result);
          setResolvedName(name);
          return;
        }
        // If zkey lookup fails, try as hex one more time
        const meta = decodeStealthMetaAddress(input);
        if (meta) {
          setResolvedMeta(meta);
          return;
        }
        setError(`"${name}.zkey.sol" not found`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve recipient");
    } finally {
      setResolving(false);
    }
  }, [recipientInput]);

  // Handle stealth transfer (transfer existing zkBTC)
  const handleStealthTransfer = async () => {
    if (!resolvedMeta || !selectedNote) {
      setError("Please resolve recipient and select a note to transfer");
      return;
    }

    if (!wallet.publicKey) {
      setError("Wallet not connected");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Create stealth deposit data for the recipient
      const stealthDeposit = await createStealthDeposit(resolvedMeta, selectedNote.amountSats);

      // TODO: In production, this would call the SDK's transferStealth function:
      // const result = await transferStealth(config, inputNote, recipientMeta, merkleProof);
      //
      // For now, simulate the transaction
      const ephemeralPubHex = Array.from(stealthDeposit.ephemeralPub).map(b => b.toString(16).padStart(2, '0')).join('');
      const commitmentHex = Array.from(stealthDeposit.commitment).map(b => b.toString(16).padStart(2, '0')).join('');

      setTransferResult({
        signature: "simulated_" + Date.now().toString(36),
        ephemeralPubKey: ephemeralPubHex,
        outputCommitment: commitmentHex,
        amount: selectedNote.amountSats,
      });

      // Refresh inbox after transfer
      if (refreshInbox) {
        await refreshInbox();
      }
    } catch (err) {
      console.error("Failed to execute stealth transfer:", err);
      setError(err instanceof Error ? err.message : "Failed to execute stealth transfer");
    } finally {
      setLoading(false);
    }
  };

  const resetFlow = () => {
    setRecipientInput("");
    setTransferResult(null);
    setResolvedMeta(null);
    setResolvedName(null);
    setSelectedNote(null);
    setError(null);
  };

  // Not connected
  if (!wallet.connected) {
    return (
      <div className="text-center py-8">
        <p className="text-body2 text-gray mb-4">
          Connect your wallet to send privately
        </p>
        <button
          onClick={() => setVisible(true)}
          className={cn(
            "inline-flex items-center gap-2 px-4 py-2 rounded-[10px]",
            "bg-privacy hover:bg-privacy/80 text-background transition-colors"
          )}
        >
          <Wallet className="w-4 h-4" />
          Connect Wallet
        </button>
      </div>
    );
  }

  // Connected but no keys
  if (!keys) {
    return (
      <div className="text-center py-8">
        <p className="text-body2 text-gray mb-4">
          Sign a message to derive your zVault keys
        </p>
        <button
          onClick={deriveKeys}
          disabled={keysLoading}
          className={cn(
            "inline-flex items-center gap-2 px-4 py-2 rounded-[10px]",
            "bg-privacy hover:bg-privacy/80 disabled:bg-gray/30",
            "text-background disabled:text-gray transition-colors"
          )}
        >
          <Key className="w-4 h-4" />
          {keysLoading ? "Signing..." : "Derive Keys"}
        </button>
      </div>
    );
  }

  // Show transfer result
  if (transferResult) {
    const btcAmount = Number(transferResult.amount) / 100_000_000;

    return (
      <div className="flex flex-col gap-4">
        {/* Success message */}
        <div className="p-4 bg-privacy/10 border border-privacy/20 rounded-[12px]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-privacy/20 flex items-center justify-center">
              <Check className="w-5 h-5 text-privacy" />
            </div>
            <div>
              <p className="text-body2-semibold text-privacy">Transfer Submitted</p>
              <p className="text-caption text-gray">
                {btcAmount} BTC sent privately
              </p>
            </div>
          </div>
        </div>

        {/* Transaction details */}
        <div className="p-4 bg-muted border border-gray/15 rounded-[12px] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-caption text-gray">Amount</span>
            <span className="text-body2 text-btc font-mono">{btcAmount} BTC</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-caption text-gray">Recipient</span>
            <span className="text-caption text-gray-light font-mono">
              {resolvedName ? `${resolvedName}.zkey.sol` : "Stealth Address"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-caption text-gray">Transaction</span>
            <a
              href={`https://orbmarkets.io/tx/${transferResult.signature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-caption text-privacy hover:text-privacy/80 flex items-center gap-1"
            >
              View on Explorer
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>

        {/* Info */}
        <div className="p-3 bg-muted border border-gray/15 rounded-[10px]">
          <p className="text-caption text-gray">
            The recipient can now scan for and claim this transfer using their stealth viewing key.
            No claim link needed - it&apos;s fully on-chain discoverable.
          </p>
        </div>

        {/* Reset */}
        <button
          onClick={resetFlow}
          className={cn(
            "flex items-center justify-center gap-2 p-3 rounded-[10px]",
            "bg-privacy/10 border border-privacy/20 text-privacy hover:bg-privacy/20 transition-colors"
          )}
        >
          <RefreshCw className="w-4 h-4" />
          New Stealth Send
        </button>
      </div>
    );
  }

  // Show form
  return (
    <div className="flex flex-col gap-4">
      {/* Note selector */}
      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Select Note to Send
        </label>
        <NoteSelector
          notes={ownedNotes}
          selectedNote={selectedNote}
          onSelect={setSelectedNote}
          isLoading={inboxLoading}
        />
      </div>

      {selectedNote && (
        <div className="p-3 bg-privacy/5 border border-privacy/20 rounded-[10px]">
          <div className="flex items-center justify-between">
            <span className="text-caption text-gray">Sending</span>
            <span className="text-body2 text-privacy font-mono">
              {formatBtc(selectedNote.amountSats)}
            </span>
          </div>
        </div>
      )}

      {/* Recipient input - supports zkey or hex */}
      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Recipient (.zkey.sol or stealth address)
        </label>
        <div className="flex gap-2">
          <input
            value={recipientInput}
            onChange={(e) => {
              setRecipientInput(e.target.value);
              setResolvedMeta(null);
              setResolvedName(null);
              setError(null);
            }}
            placeholder="alice.zkey.sol or 130 hex chars"
            className={cn(
              "flex-1 p-3 bg-muted border rounded-[10px]",
              "text-body2 font-mono text-foreground placeholder:text-gray",
              "outline-none transition-colors",
              error ? "border-red-500/50" : "border-gray/30 focus:border-privacy/50"
            )}
          />
          <button
            onClick={resolveRecipient}
            disabled={!recipientInput.trim() || resolving}
            className={cn(
              "px-4 py-2 rounded-[10px] text-body2 transition-colors",
              "bg-privacy hover:bg-privacy/80 text-background",
              "disabled:bg-gray/30 disabled:text-gray disabled:cursor-not-allowed"
            )}
          >
            {resolving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Resolve"}
          </button>
        </div>
        {resolvedMeta && (
          <p className="text-caption text-privacy mt-1 pl-2 flex items-center gap-1">
            <Check className="w-3 h-3" />
            {resolvedName ? (
              <>
                <Tag className="w-3 h-3" />
                {resolvedName}.zkey.sol resolved
              </>
            ) : (
              "Valid stealth address"
            )}
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[10px] text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-caption">{error}</span>
        </div>
      )}

      {/* Action button */}
      <button
        onClick={handleStealthTransfer}
        disabled={loading || !resolvedMeta || !selectedNote}
        className={cn(
          "flex items-center justify-center gap-2 p-3 rounded-[10px]",
          "bg-privacy hover:bg-privacy/80 text-background",
          "disabled:bg-gray/30 disabled:text-gray disabled:cursor-not-allowed",
          "transition-colors"
        )}
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Transferring...
          </>
        ) : (
          <>
            <Send className="w-4 h-4" />
            Send Privately
            {selectedNote && (
              <>
                <ArrowRight className="w-3 h-3" />
                <span className="font-mono">{formatBtc(selectedNote.amountSats)}</span>
              </>
            )}
          </>
        )}
      </button>

      {/* Info */}
      <div className="p-3 bg-muted border border-gray/15 rounded-[10px]">
        <p className="text-caption text-gray">
          Transfer your existing zkBTC directly to the recipient. The transfer happens on-chain
          and is fully private - only the recipient can claim it with their stealth keys.
        </p>
      </div>

      {/* Link to deposit page */}
      <Link
        href="/bridge/deposit"
        className={cn(
          "flex items-center justify-center gap-2 p-3 rounded-[10px]",
          "bg-btc/10 border border-btc/20 text-btc hover:bg-btc/20 transition-colors"
        )}
      >
        <ArrowDownToLine className="w-4 h-4" />
        New BTC Deposit
      </Link>
    </div>
  );
}
