"use client";

/**
 * PaymentWizard — config-driven 3-screen wizard for simplified payment flows.
 *
 * Screens: Amount → Recipient → Confirm/Processing/Success
 * Each flow (transfer, unshield, withdraw) is a FlowConfig object, not a separate component.
 */

import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { motion } from "framer-motion";
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, Key, Loader2, Shield,
  AlertTriangle, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseSats } from "@/lib/utils/validation";
import { formatAmount } from "@/lib/utils/formatting";
import { useAegis, useAegisKeys } from "@/hooks/use-aegis";
import { useNoteAutoSelector } from "@/hooks/use-note-auto-selector";
import { useJoinSplitSubmit } from "@/hooks/use-joinsplit-submit";
import { buildTransferParams, type TransferMode } from "@/hooks/use-build-transfer-params";
import { usePayFlowAuth } from "@/hooks/use-pay-flow-auth";
import { useRelayerConfig } from "@/hooks/use-relayer-config";
import { AuthModal } from "@/components/auth-modal";
import { PAY_TOKENS, type PayToken } from "@/components/btc-widget/pay-flow/helpers";
import { AVAILABLE_CIRCUITS, MIN_PAY_SATS } from "@/components/btc-widget/pay-flow/helpers";
import { BTC_DUST_LIMIT, BTC_MINER_FEE_ESTIMATE } from "@/lib/btc-constants";
import { setActiveToken } from "@/lib/token-context";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";
import { validateBtcAddress as validateBtcAddressFn } from "@/components/ui/btc-address-input";
import type { StealthMetaAddress } from "@aegis/sdk";

// ─── Flow Config ────────────────────────────────────────────────────

export interface FlowConfig {
  mode: TransferMode;
  label: string;
  recipientLabel: string;
  recipientPlaceholder: string;
  recipientIcon: ReactNode;
  defaultRecipientFromWallet?: boolean;
  validateRecipient: (addr: string) => boolean;
  resolveRecipient?: (addr: string) => Promise<StealthMetaAddress | null>;
  showFeeBreakdown?: boolean;
  privacyWarning?: string;
  confirmLabel: string;
  /** For BTC: compute service fee from amount */
  computeServiceFee?: (amountSats: number) => number;
}

type WizardStep = "auth" | "amount" | "recipient" | "confirm";

// ─── Processing Steps ───────────────────────────────────────────────

const PROCESSING_STEPS = [
  { match: "Preparing", label: "Preparing transaction" },
  { match: "Processing", label: "Processing" },
  { match: "Submitting", label: "Submitting on-chain" },
];

function ProcessingIndicator({ message }: { message: string }) {
  const currentIdx = PROCESSING_STEPS.findIndex((s) => message.startsWith(s.match));
  const idx = currentIdx >= 0 ? currentIdx : 0;

  return (
    <div className="space-y-2.5" role="status" aria-live="polite" aria-label="Transaction progress">
      {PROCESSING_STEPS.map((s, i) => {
        const isComplete = i < idx;
        const isCurrent = i === idx;
        return (
          <div key={s.match} className="flex items-center gap-3">
            <div className="w-5 h-5 flex items-center justify-center shrink-0">
              {isComplete ? (
                <CheckCircle2 className="w-4.5 h-4.5 text-green-400" />
              ) : isCurrent ? (
                <Loader2 className="w-4.5 h-4.5 text-privacy animate-spin" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-gray/20" />
              )}
            </div>
            <span className={cn(
              "text-sm transition-colors duration-200",
              isComplete && "text-green-400",
              isCurrent && "text-foreground font-medium",
              !isComplete && !isCurrent && "text-gray/35",
            )}>
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Step Dots ──────────────────────────────────────────────────────

const STEP_LABELS = ["Amount", "Recipient", "Confirm"];

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 justify-center mb-6" role="navigation" aria-label="Progress">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          aria-label={`Step ${i + 1}: ${STEP_LABELS[i] || ""}`}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "h-1.5 rounded-full transition-all duration-300 ease-out",
            i === current ? "bg-privacy w-6" : i < current ? "bg-privacy/40 w-1.5" : "bg-gray/15 w-1.5",
          )}
        />
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function PaymentWizard({ config }: { config: FlowConfig }) {
  const { publicKey, connected } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { keys, hasKeys, deriveKeys, isLoading: keysLoading, stealthAddress } = useAegisKeys();
  const { refreshInbox, refreshPublicBalance } = useAegis();

  const {
    authModalOpen, setAuthModalOpen,
    passkeySupported, hasPasskeyCredential,
    passkeyLoading, passkeyError,
    handlePasskeyRegister, handlePasskeyAuthenticate,
  } = usePayFlowAuth(hasKeys);

  // Wizard state
  const [step, setStep] = useState<WizardStep>("auth");
  const [selectedToken, setSelectedToken] = useState<PayToken>(PAY_TOKENS[0]);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [showTokenPicker, setShowTokenPicker] = useState(false);

  // BTC-specific
  const [btcScriptPubKey, setBtcScriptPubKey] = useState<Uint8Array | null>(null);

  const submitter = useJoinSplitSubmit();

  // Sync token context
  useEffect(() => {
    if (selectedToken.mint) setActiveToken(selectedToken.mint);
  }, [selectedToken.mint]);

  // Relayer config
  const { relayerMeta, effectiveRelayerFee, effectiveServiceFee, effectiveServiceFeeBps } = useRelayerConfig(selectedToken);

  // Parse amount
  const amountSats = parseSats(amount) ?? 0;
  const totalNeeded = amountSats + effectiveRelayerFee;

  // Note selection
  const noteSelector = useNoteAutoSelector(selectedToken.shieldedSymbol, totalNeeded);
  const fmt = (raw: number) => formatAmount(raw, selectedToken.decimals);

  // Auth step transitions
  useEffect(() => {
    if (hasKeys && step === "auth") setStep("amount");
    if (!hasKeys && step !== "auth") setStep("auth");
  }, [hasKeys, step]);

  // Pre-fill recipient from wallet
  useEffect(() => {
    if (config.defaultRecipientFromWallet && publicKey && !recipient) {
      setRecipient(publicKey.toBase58());
    }
  }, [config.defaultRecipientFromWallet, publicKey, recipient]);

  // Resolve stealth recipient
  useEffect(() => {
    if (config.mode !== "stealth" || !recipient || !config.resolveRecipient) return;
    let cancelled = false;
    setIsResolving(true);
    setResolvedMeta(null);
    setResolvedName(null);
    setRecipientError(null);

    config.resolveRecipient(recipient).then((meta) => {
      if (cancelled) return;
      if (meta) {
        setResolvedMeta(meta);
        setResolvedName(recipient);
        setRecipientError(null);
      } else {
        setRecipientError("Could not resolve address");
      }
      setIsResolving(false);
    }).catch(() => {
      if (!cancelled) {
        setRecipientError("Resolution failed");
        setIsResolving(false);
      }
    });

    return () => { cancelled = true; };
  }, [recipient, config]);

  // Validate BTC address
  useEffect(() => {
    if (config.mode !== "btc" || !recipient) {
      if (config.mode === "btc") { setBtcScriptPubKey(null); setRecipientError(null); }
      return;
    }
    const result = validateBtcAddressFn(recipient);
    if (result.valid && result.scriptPubKey) {
      setBtcScriptPubKey(result.scriptPubKey);
      setRecipientError(null);
    } else {
      setBtcScriptPubKey(null);
      setRecipientError(result.error || "Invalid Bitcoin address");
    }
  }, [recipient, config.mode]);

  // BTC fee breakdown (must be before validation)
  const serviceFee = config.computeServiceFee ? config.computeServiceFee(amountSats) : 0;
  const btcReceiveAmount = amountSats > 0 ? amountSats - serviceFee - BTC_MINER_FEE_ESTIMATE : 0;

  // Validation
  const amountValid = amountSats >= MIN_PAY_SATS
    && totalNeeded <= noteSelector.totalAvailable
    && (config.mode !== "btc" || btcReceiveAmount >= BTC_DUST_LIMIT);
  const recipientValid = useMemo(() => {
    if (!recipient) return false;
    if (config.mode === "stealth") return !!resolvedMeta;
    if (config.mode === "btc") return !!btcScriptPubKey;
    return config.validateRecipient(recipient);
  }, [recipient, config, resolvedMeta, btcScriptPubKey]);

  // Circuit check
  const nInputs = noteSelector.selectedNotes.length;
  const changeSats = noteSelector.totalSelected - totalNeeded;
  const nOutputs = 1 + (changeSats > 0 ? 1 : 0) + (effectiveRelayerFee > 0 ? 1 : 0);
  const circuitKey = `${nInputs}x${nOutputs}`;
  const circuitAvailable = nInputs > 0 && AVAILABLE_CIRCUITS.has(circuitKey);

  // Submit handler
  const handleConfirm = useCallback(async () => {
    if (!keys || !stealthAddress) return;

    const { decodeStealthMetaAddress } = await import("@aegis/sdk");

    const params = await buildTransferParams({
      mode: config.mode,
      amountSats: BigInt(amountSats),
      selectedNotes: noteSelector.selectedNotes,
      keys,
      selfMeta: stealthAddress,
      relayerMeta: relayerMeta?.stealthMeta
        ? decodeStealthMetaAddress(relayerMeta.stealthMeta)
        : undefined,
      relayerFee: effectiveRelayerFee,
      recipient: {
        stealthMeta: resolvedMeta || undefined,
        solanaAddress: config.mode === "public" ? recipient : undefined,
        btcScriptPubKey: btcScriptPubKey || undefined,
      },
    });

    await submitter.submit(params, BigInt(amountSats));

    // Auto-refresh after success
    for (const delay of [2000, 5000, 10000]) {
      setTimeout(() => {
        refreshInbox(undefined, true);
        if (publicKey) refreshPublicBalance?.(publicKey);
      }, delay);
    }
  }, [keys, stealthAddress, config, amountSats, noteSelector.selectedNotes, relayerMeta, effectiveRelayerFee, resolvedMeta, recipient, btcScriptPubKey, submitter, refreshInbox, refreshPublicBalance, publicKey]);

  // ─── AUTH ──────────────────────────────────────────────────────────

  if (step === "auth") {
    return (
      <>
        <div className="flex flex-col items-center justify-center py-8">
          <div className="rounded-full bg-privacy/10 p-4 mb-4">
            <Shield className="h-10 w-10 text-privacy" />
          </div>
          <p className="text-sm text-gray text-center mb-4">
            Sign in to {config.label.toLowerCase()} tokens
          </p>
          <button
            onClick={() => setAuthModalOpen(true)}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-privacy hover:bg-privacy/80 text-background font-medium transition-all cursor-pointer"
          >
            <Key className="w-4 h-4" />
            Sign In
          </button>
        </div>
        <AuthModal
          open={authModalOpen}
          onOpenChange={setAuthModalOpen}
          auth={{
            passkeySupported,
            hasPasskeyCredential,
            passkeyLoading,
            walletLoading: keysLoading,
            walletConnected: connected,
            error: passkeyError,
            onPasskeyRegister: handlePasskeyRegister,
            onPasskeyAuthenticate: handlePasskeyAuthenticate,
            onWalletConnect: () => { setAuthModalOpen(false); setWalletModalVisible(true); },
            onWalletDeriveKeys: async () => { await deriveKeys(); setAuthModalOpen(false); },
          }}
        />
      </>
    );
  }

  // ─── PROCESSING / SUCCESS / ERROR ─────────────────────────────────

  if (submitter.status !== "idle" && submitter.status !== "error") {
    if (submitter.status === "success") {
      return (
        <motion.div
          className="flex flex-col items-center py-8"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <div className="rounded-full bg-green-500/10 p-4 mb-4">
            <CheckCircle2 className="h-10 w-10 text-green-400" />
          </div>
          <h3 className="text-lg font-bold text-foreground mb-1">
            {config.mode === "btc" ? "Withdrawal Submitted" : config.mode === "public" ? "Cash Out Complete" : "Sent Successfully"}
          </h3>
          <p className="text-sm text-gray mb-4">
            {fmt(amountSats)} {selectedToken.shieldedSymbol}
          </p>
          {submitter.txSignature && (
            <a
              href={getSolanaExplorerTxUrl(submitter.txSignature)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-privacy hover:text-privacy/80 mb-6"
            >
              View on Explorer <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <button
            onClick={() => { submitter.reset(); setStep("amount"); setAmount(""); setRecipient(""); }}
            className="px-6 py-2.5 rounded-xl bg-muted hover:bg-muted/80 text-sm text-foreground transition-colors cursor-pointer"
          >
            Done
          </button>
        </motion.div>
      );
    }

    // Processing
    return (
      <div className="flex flex-col items-center py-8">
        <div className="rounded-full bg-privacy/10 p-4 mb-6">
          <Loader2 className="h-8 w-8 text-privacy animate-spin" />
        </div>
        <ProcessingIndicator message={submitter.statusMessage} />
        <p className="text-xs text-gray/50 mt-4">This may take up to 60 seconds</p>
      </div>
    );
  }

  // ─── AMOUNT STEP ──────────────────────────────────────────────────

  if (step === "amount") {
    return (
      <div>
        <StepDots current={0} total={3} />

        {/* Token Picker */}
        <div className="mb-4">
          <label className="text-xs text-gray/60 uppercase tracking-wider mb-1.5 block">Token</label>
          <button
            onClick={() => setShowTokenPicker(!showTokenPicker)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-muted/50 border border-gray/15 hover:border-gray/30 transition-colors cursor-pointer"
          >
            <img src={selectedToken.shieldedLogo} alt="" className="w-7 h-7 rounded-full" />
            <span className="text-sm font-medium text-foreground">{selectedToken.shieldedSymbol}</span>
            <span className="flex-1" />
            <span className="text-xs text-gray/50">Balance: {fmt(noteSelector.totalAvailable)}</span>
          </button>
          {showTokenPicker && (
            <div className="mt-1 rounded-xl border border-gray/15 bg-card overflow-hidden">
              {PAY_TOKENS.map((t) => (
                <button
                  key={t.symbol}
                  onClick={() => { setSelectedToken(t); setShowTokenPicker(false); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer"
                >
                  <img src={t.shieldedLogo} alt="" className="w-6 h-6 rounded-full" />
                  <span className="text-sm text-foreground">{t.shieldedSymbol}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Amount Input */}
        <div className="mb-4">
          <label className="text-xs text-gray/60 uppercase tracking-wider mb-1.5 block">Amount</label>
          <div className="relative">
            <input
              type="text"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0"
              className="w-full px-4 py-3 pr-20 rounded-xl bg-muted/50 border border-gray/15 text-lg font-mono text-foreground placeholder:text-gray/25 transition-all duration-200 outline-none focus:border-privacy/40 focus-visible:ring-2 focus-visible:ring-privacy/20"
            />
            <button
              onClick={() => setAmount(String(noteSelector.totalAvailable - effectiveRelayerFee))}
              className="absolute right-3 top-1/2 -translate-y-1/2 px-2 py-1 rounded-md bg-privacy/10 text-xs text-privacy font-medium hover:bg-privacy/20 transition-colors cursor-pointer"
            >
              Max
            </button>
          </div>
          {amountSats > 0 && totalNeeded > noteSelector.totalAvailable && (
            <p className="text-xs text-red-400 mt-1" role="alert">Insufficient balance</p>
          )}
        </div>

        {/* Error from previous attempt */}
        {submitter.error && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-red-500/8 border border-red-500/15 mb-4" role="alert">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-xs text-red-300">{submitter.error}</p>
          </div>
        )}

        <button
          onClick={() => { submitter.reset(); setStep("recipient"); }}
          disabled={!amountValid || !noteSelector.hasNotes}
          className={cn(
            "w-full flex items-center justify-center gap-2 py-3 min-h-[44px] rounded-xl font-medium text-sm",
            "transition-all duration-200 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-privacy/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            amountValid && noteSelector.hasNotes
              ? "bg-privacy hover:bg-privacy/85 text-background active:scale-[0.98]"
              : "bg-gray/15 text-gray/35 cursor-not-allowed",
          )}
        >
          Next <ArrowRight className="w-4 h-4" />
        </button>

        {!noteSelector.hasNotes && !noteSelector.isLoading && (
          <p className="text-xs text-gray/50 text-center mt-3">
            No shielded notes available. <a href="/vault/deposit" className="text-privacy hover:underline">Deposit first</a>
          </p>
        )}
      </div>
    );
  }

  // ─── RECIPIENT STEP ───────────────────────────────────────────────

  if (step === "recipient") {
    return (
      <div>
        <StepDots current={1} total={3} />

        <button
          onClick={() => setStep("amount")}
          className="flex items-center gap-1 text-xs text-gray/50 hover:text-foreground transition-colors mb-4 cursor-pointer"
        >
          <ArrowLeft className="w-3 h-3" /> Back
        </button>

        <label className="text-xs text-gray/60 uppercase tracking-wider mb-1.5 block">
          {config.recipientLabel}
        </label>
        <div className="relative mb-3">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray/40">
            {config.recipientIcon}
          </div>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.trim())}
            placeholder={config.recipientPlaceholder}
            className="w-full pl-10 pr-10 py-3 rounded-xl bg-muted/50 border border-gray/15 text-sm font-mono text-foreground placeholder:text-gray/25 transition-all duration-200 outline-none focus:border-privacy/40 focus-visible:ring-2 focus-visible:ring-privacy/20"
          />
          {isResolving && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-privacy animate-spin" />
          )}
          {recipientValid && !isResolving && (
            <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-400" />
          )}
        </div>

        {recipientError && (
          <p className="text-xs text-red-400 mb-3">{recipientError}</p>
        )}
        {resolvedName && config.mode === "stealth" && (
          <p className="text-xs text-green-400 mb-3">Resolved: {resolvedName}</p>
        )}

        {/* Privacy warning */}
        {config.privacyWarning && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 mb-4">
            <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <p className="text-xs text-yellow-400">{config.privacyWarning}</p>
          </div>
        )}

        {/* BTC fee breakdown */}
        {config.showFeeBreakdown && amountSats > 0 && (
          <div className="px-3 py-2.5 rounded-lg bg-btc/5 border border-btc/15 mb-4 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-gray/60">Service fee</span>
              <span className="text-foreground font-mono">-{fmt(serviceFee)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray/60">Est. miner fee</span>
              <span className="text-foreground font-mono">-{fmt(BTC_MINER_FEE_ESTIMATE)}</span>
            </div>
            <div className="border-t border-btc/10 pt-1 flex justify-between text-xs">
              <span className="text-gray/80 font-medium">You receive</span>
              <span className="text-foreground font-mono font-medium">{fmt(Math.max(0, btcReceiveAmount))}</span>
            </div>
          </div>
        )}

        <button
          onClick={() => setStep("confirm")}
          disabled={!recipientValid}
          className={cn(
            "w-full flex items-center justify-center gap-2 py-3 min-h-[44px] rounded-xl font-medium text-sm",
            "transition-all duration-200 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-privacy/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            recipientValid
              ? "bg-privacy hover:bg-privacy/85 text-background active:scale-[0.98]"
              : "bg-gray/15 text-gray/35 cursor-not-allowed",
          )}
        >
          Next <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // ─── CONFIRM STEP ─────────────────────────────────────────────────

  if (step === "confirm") {
    const recipientDisplay = recipient.length > 20
      ? `${recipient.slice(0, 8)}...${recipient.slice(-6)}`
      : recipient;

    return (
      <div>
        <StepDots current={2} total={3} />

        <button
          onClick={() => setStep("recipient")}
          className="flex items-center gap-1 text-xs text-gray/50 hover:text-foreground transition-colors mb-4 cursor-pointer"
        >
          <ArrowLeft className="w-3 h-3" /> Back
        </button>

        {/* Summary card */}
        <div className="rounded-xl border border-gray/15 bg-muted/30 p-4 mb-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray/60">Sending</span>
            <span className="text-lg font-bold font-mono text-foreground">
              {fmt(amountSats)} {selectedToken.shieldedSymbol}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray/60">To</span>
            <span className="text-sm font-mono text-foreground">{recipientDisplay}</span>
          </div>
          {config.showFeeBreakdown && (
            <div className="flex items-center justify-between border-t border-gray/10 pt-2">
              <span className="text-xs text-gray/60">Receives</span>
              <span className="text-sm font-mono text-green-400">{fmt(Math.max(0, btcReceiveAmount))}</span>
            </div>
          )}
          {changeSats > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray/60">Change</span>
              <span className="text-xs font-mono text-gray/50">{fmt(changeSats)}</span>
            </div>
          )}
          {effectiveRelayerFee > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray/60">Relayer fee</span>
              <span className="text-xs font-mono text-gray/50">{fmt(effectiveRelayerFee)}</span>
            </div>
          )}
          {!circuitAvailable && nInputs > 0 && (
            <p className="text-xs text-red-400">Circuit {circuitKey} not available</p>
          )}
        </div>

        <button
          onClick={handleConfirm}
          disabled={!circuitAvailable || submitter.status !== "idle"}
          className={cn(
            "w-full flex items-center justify-center gap-2 py-3 min-h-[44px] rounded-xl font-medium text-sm",
            "transition-all duration-200 ease-out cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-privacy/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            circuitAvailable
              ? "bg-privacy hover:bg-privacy/85 text-background active:scale-[0.98]"
              : "bg-gray/15 text-gray/35 cursor-not-allowed",
          )}
        >
          {config.confirmLabel}
        </button>
      </div>
    );
  }

  return null;
}
