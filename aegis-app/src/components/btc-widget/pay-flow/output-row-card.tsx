"use client";

/**
 * OutputRowCard — renders a single output in the JoinSplit compose step.
 * Supports 4 output modes: Private (stealth), Link (note), Solana (public), Bitcoin (BTC).
 * Each mode has its own recipient input, amount field, and fee estimation.
 */

import {
  Shield, Wallet, AlertCircle, Check, Link2, FileText, Bitcoin, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseSats } from "@/lib/utils/validation";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import { BtcAddressInput } from "@/components/ui/btc-address-input";
import type { StealthMetaAddress } from "@aegis/sdk";
import type { OutputRow } from "./helpers";
import { isValidSolanaAddress } from "./helpers";
import { NoteLinkPreview } from "./note-links";

export interface OutputRowCardProps {
  output: OutputRow;
  index: number;
  canRemove: boolean;
  onUpdate: (update: Partial<OutputRow>) => void;
  onRemove: () => void;
  defaultAddress: string;
  disablePublic?: boolean;
  disableBtc?: boolean;
  selfMeta?: StealthMetaAddress | null;
  maxAmount: number;
  serviceFeeSats?: number;
  serviceFeeBps?: number;
}

export function OutputRowCard({
  output,
  index,
  canRemove,
  onUpdate,
  onRemove,
  defaultAddress,
  disablePublic = false,
  disableBtc = false,
  selfMeta,
  maxAmount,
  serviceFeeSats = 0,
  serviceFeeBps = 0,
}: OutputRowCardProps) {

  return (
    <div className="p-4 rounded-[12px] bg-card border border-gray/15">
      {/* Type selector row */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex flex-1 p-0.5 bg-muted rounded-[8px] border border-gray/10">
          {([
            { mode: "stealth" as const, label: "Private", icon: Shield, activeClass: "bg-purple/20 text-purple", disabled: false },
            { mode: "note" as const, label: "Link", icon: Link2, activeClass: "bg-btc/20 text-btc", disabled: false },
            { mode: "public" as const, label: "Solana", icon: Wallet, activeClass: "bg-privacy/20 text-privacy", disabled: disablePublic && output.mode !== "public" },
            { mode: "btc" as const, label: "Bitcoin", icon: Bitcoin, activeClass: "bg-btc/20 text-btc", disabled: disableBtc && output.mode !== "btc" },
          ] as const).map((tab) => (
            <button
              key={tab.mode}
              onClick={() => {
                if (tab.disabled) return;
                const reset: Partial<OutputRow> = { mode: tab.mode };
                if (tab.mode === "public") { reset.stealthError = null; reset.solanaAddress = defaultAddress; }
                else if (tab.mode === "stealth") { reset.addressError = null; }
                else if (tab.mode === "note") { reset.addressError = null; reset.stealthError = null; }
                else { reset.addressError = null; reset.stealthError = null; }
                onUpdate(reset);
              }}
              disabled={tab.disabled}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-[6px] text-[11px] font-medium transition-colors",
                output.mode === tab.mode
                  ? tab.activeClass
                  : tab.disabled
                    ? "text-gray/30 cursor-not-allowed"
                    : "text-gray hover:text-gray-light"
              )}
              title={
                tab.mode === "public" && tab.disabled ? "Only 1 public/BTC output per transaction" :
                tab.mode === "btc" && tab.disabled ? "Only 1 public/BTC output per transaction" :
                undefined
              }
            >
              <tab.icon className="w-3 h-3" />
              {tab.label}
            </button>
          ))}
        </div>
        {canRemove && (
          <button
            onClick={onRemove}
            className="p-1 rounded text-gray/50 hover:text-error transition-colors shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Recipient — mode-specific */}
      <RecipientInput output={output} onUpdate={onUpdate} defaultAddress={defaultAddress} selfMeta={selfMeta} />

      {/* Amount */}
      <label className="text-body2 text-gray-light pl-2 mb-2 block">Amount</label>
      <div className="flex items-center gap-3">
        <input
          type="number"
          value={output.amount}
          onChange={(e) => onUpdate({ amount: e.target.value })}
          placeholder="0"
          min="0"
          className={cn(
            "flex-1 px-4 py-3 bg-muted border border-gray/20 rounded-[10px]",
            "text-body2 font-mono text-foreground placeholder:text-gray",
            "outline-none focus:border-purple/40 transition-colors",
            "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          )}
        />
        <button
          type="button"
          onClick={() => onUpdate({ amount: String(maxAmount) })}
          className="text-xs text-purple hover:text-purple/80 font-medium shrink-0"
        >
          Max
        </button>
        <span className="text-body2 text-gray shrink-0">sats</span>
      </div>

      {/* BTC fee estimate */}
      {output.mode === "btc" && (
        <BtcFeeEstimate amount={output.amount} serviceFeeSats={serviceFeeSats} serviceFeeBps={serviceFeeBps} />
      )}
    </div>
  );
}

// --- Sub-components ---

function RecipientInput({ output, onUpdate, defaultAddress, selfMeta }: {
  output: OutputRow;
  onUpdate: (update: Partial<OutputRow>) => void;
  defaultAddress: string;
  selfMeta?: StealthMetaAddress | null;
}) {
  if (output.mode === "btc") {
    return (
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
    );
  }

  if (output.mode === "note") {
    return (
      <div className="mb-2">
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Secret Phrase (share to let someone claim)
        </label>
        <div className="relative">
          <FileText className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-btc" />
          <input
            type="text"
            value={output.secretPhrase}
            onChange={(e) => onUpdate({ secretPhrase: e.target.value })}
            placeholder="alpha-bravo-charlie-1234"
            className={cn(
              "w-full pl-10 pr-4 py-3 bg-muted border rounded-[10px]",
              "text-body2 font-mono text-foreground placeholder:text-gray/40",
              "outline-none transition-colors",
              output.secretPhrase.trim().length >= 8
                ? "border-btc/30"
                : "border-gray/20 focus:border-btc/40"
            )}
          />
        </div>
        {output.secretPhrase.trim().length > 0 && output.secretPhrase.trim().length < 8 && (
          <p className="text-caption text-gray mt-1 pl-2">
            Min 8 characters ({8 - output.secretPhrase.trim().length} more)
          </p>
        )}
        {output.secretPhrase.trim().length >= 8 && (
          <NoteLinkPreview phrase={output.secretPhrase.trim()} />
        )}
      </div>
    );
  }

  if (output.mode === "stealth") {
    return (
      <div className="mb-2">
        <StealthRecipientInput
          onResolved={(meta, name) =>
            onUpdate({ resolvedMeta: meta, resolvedName: name })
          }
          resolvedMeta={output.resolvedMeta}
          resolvedName={output.resolvedName}
          error={output.stealthError}
          onError={(err) => onUpdate({ stealthError: err })}
          icon={<Shield className="w-4 h-4 text-purple" />}
          selfMeta={selfMeta}
        />
      </div>
    );
  }

  // Public (Solana) mode
  return (
    <div className="mb-2">
      <label className="text-body2 text-gray-light pl-2 mb-2 block">
        Solana Recipient Address
      </label>
      <div className="relative">
        <Wallet className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-privacy" />
        <input
          type="text"
          value={output.solanaAddress}
          onChange={(e) => onUpdate({ solanaAddress: e.target.value, addressError: null })}
          placeholder="Solana address..."
          className={cn(
            "w-full pl-10 pr-4 py-3 bg-muted border rounded-[10px]",
            "text-body2 font-mono text-foreground placeholder:text-gray/40",
            "outline-none transition-colors",
            output.addressError
              ? "border-error/50"
              : isValidSolanaAddress(output.solanaAddress)
                ? "border-privacy/40"
                : "border-gray/20 focus:border-privacy/40"
          )}
        />
      </div>
      {output.addressError && (
        <div className="flex items-center gap-2 text-error pl-2 mt-1">
          <AlertCircle className="w-3.5 h-3.5" />
          <span className="text-caption">{output.addressError}</span>
        </div>
      )}
      {output.solanaAddress && isValidSolanaAddress(output.solanaAddress) && (
        <p className="text-caption text-privacy pl-2 mt-1 flex items-center gap-1">
          <Check className="w-3.5 h-3.5" />
          Valid Solana address
        </p>
      )}
    </div>
  );
}

function BtcFeeEstimate({ amount, serviceFeeSats, serviceFeeBps }: {
  amount: string;
  serviceFeeSats: number;
  serviceFeeBps: number;
}) {
  const amountSats = parseSats(amount) ?? 0;
  if (amountSats <= 0) return null;
  const percentFee = Math.ceil(amountSats * serviceFeeBps / 10000);
  const totalFee = serviceFeeSats + percentFee;
  const receiveSats = Math.max(0, amountSats - totalFee);
  const bpsDisplay = (serviceFeeBps / 100).toFixed(serviceFeeBps % 100 === 0 ? 0 : 1);

  return (
    <div className="mt-2 px-2 py-2 rounded-[8px] bg-btc/5 border border-btc/10 space-y-1">
      <div className="flex justify-between text-[11px]">
        <span className="text-gray">Base fee (incl. miner fee)</span>
        <span className="text-gray">−{serviceFeeSats.toLocaleString()} sats</span>
      </div>
      <div className="flex justify-between text-[11px]">
        <span className="text-gray">Protocol fee ({bpsDisplay}%)</span>
        <span className="text-gray">−{percentFee.toLocaleString()} sats</span>
      </div>
      <div className="flex justify-between text-[11px] pt-1 border-t border-btc/10">
        <span className="text-btc font-medium">You receive</span>
        <span className="text-btc font-semibold">
          {receiveSats.toLocaleString()} sats
        </span>
      </div>
    </div>
  );
}
