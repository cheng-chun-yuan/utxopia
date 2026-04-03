"use client";

/**
 * OutputRowCard — renders a single output in the JoinSplit compose step.
 * Compact horizontal layout: [Type Dropdown] [Address Input] [Amount] [Delete]
 */

import { useState, useRef, useEffect } from "react";
import {
  Shield, Wallet, AlertCircle, Check, Link2, FileText, Bitcoin, Trash2,
  ChevronDown, Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseSats } from "@/lib/utils/validation";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import { BtcAddressInput } from "@/components/ui/btc-address-input";
import type { StealthMetaAddress } from "@privacy-coin/sdk";
import type { OutputRow } from "./helpers";
import { isValidSolanaAddress } from "./helpers";
import { NoteLinkPreview } from "./note-links";

export interface OutputRowHandlers {
  onUpdate: (update: Partial<OutputRow>) => void;
  onRemove: () => void;
}

export interface OutputRowConfig {
  defaultAddress: string;
  disablePublic?: boolean;
  disableBtc?: boolean;
  selfMeta?: StealthMetaAddress | null;
  maxAmount: number;
  serviceFeeSats?: number;
  serviceFeeBps?: number;
  tokenUnit?: string;
  tokenSymbol?: string;
}

export interface OutputRowCardProps {
  output: OutputRow;
  index: number;
  canRemove: boolean;
  handlers: OutputRowHandlers;
  config: OutputRowConfig;
}

const MODE_OPTIONS = [
  { mode: "stealth" as const, label: "Stealth", icon: Shield, color: "text-purple", private: true },
  { mode: "note" as const, label: "Link", icon: Link2, color: "text-btc", private: true },
  { mode: "public" as const, label: "Solana", icon: Wallet, color: "text-privacy", private: false },
  { mode: "btc" as const, label: "Bitcoin", icon: Bitcoin, color: "text-btc", private: false },
] as const;

export function OutputRowCard({ output, index, canRemove, handlers, config }: OutputRowCardProps) {
  const { onUpdate, onRemove } = handlers;
  const {
    defaultAddress,
    disablePublic = false,
    disableBtc = false,
    selfMeta,
    maxAmount,
    serviceFeeSats = 0,
    serviceFeeBps = 0,
    tokenUnit = "sats",
    tokenSymbol = "zkBTC",
  } = config;
  const currentMode = MODE_OPTIONS.find((m) => m.mode === output.mode) ?? MODE_OPTIONS[0];

  return (
    <div className="rounded-[12px] bg-card border border-gray/15 p-3 space-y-2">
      {/* Row 1: Type chip + Delete */}
      <div className="flex items-center justify-between">
        <TypeDropdown
          currentMode={output.mode}
          disablePublic={disablePublic}
          disableBtc={disableBtc}
          onChange={(mode) => {
            const reset: Partial<OutputRow> = { mode };
            if (mode === "public") { reset.stealthError = null; reset.solanaAddress = defaultAddress; }
            else if (mode === "stealth") { reset.addressError = null; }
            else if (mode === "note") { reset.addressError = null; reset.stealthError = null; }
            else { reset.addressError = null; reset.stealthError = null; }
            onUpdate(reset);
          }}
        />
        {canRemove && (
          <button
            onClick={onRemove}
            className="p-1.5 rounded text-gray/40 hover:text-error transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Row 2: Address input (full width) */}
      <RecipientInput output={output} onUpdate={onUpdate} defaultAddress={defaultAddress} selfMeta={selfMeta} />

      {/* Row 3: Amount input (full width) */}
      <div className="relative">
        <input
          type="number"
          value={output.amount}
          onChange={(e) => onUpdate({ amount: e.target.value })}
          placeholder="0"
          min="0"
          className={cn(
            "w-full pl-3 pr-24 py-2.5 bg-muted rounded-[8px]",
            "text-body2 font-mono text-foreground placeholder:text-gray text-right",
            "outline-none focus:ring-1 focus:ring-purple/30 transition-shadow",
            "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          )}
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onUpdate({ amount: String(maxAmount) })}
            className="text-[10px] text-purple hover:text-purple/80 font-medium"
          >
            Max
          </button>
          <span className="text-[11px] text-gray">{tokenUnit}</span>
        </div>
      </div>

      {/* BTC fee estimate */}
      {output.mode === "btc" && (
        <BtcFeeEstimate amount={output.amount} serviceFeeSats={serviceFeeSats} serviceFeeBps={serviceFeeBps} />
      )}

      {/* Note link preview */}
      {output.mode === "note" && output.secretPhrase.trim().length >= 8 && (
        <NoteLinkPreview phrase={output.secretPhrase.trim()} />
      )}
    </div>
  );
}

// --- Type Dropdown ---

function TypeDropdown({ currentMode, disablePublic, disableBtc, onChange }: {
  currentMode: OutputRow["mode"];
  disablePublic: boolean;
  disableBtc: boolean;
  onChange: (mode: OutputRow["mode"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = MODE_OPTIONS.find((m) => m.mode === currentMode) ?? MODE_OPTIONS[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] transition-colors text-[12px] font-medium",
          current.private
            ? "bg-purple/10 text-purple hover:bg-purple/15"
            : "bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/15"
        )}
        title={current.label}
      >
        <current.icon className="w-3.5 h-3.5" />
        <span>{current.label}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-[100] w-[140px] py-1 bg-card border border-gray/20 rounded-[10px] shadow-xl">
          {MODE_OPTIONS.map((opt) => {
            const disabled =
              (opt.mode === "public" && disablePublic && currentMode !== "public") ||
              (opt.mode === "btc" && disableBtc && currentMode !== "btc");
            return (
              <button
                key={opt.mode}
                disabled={disabled}
                onClick={() => { onChange(opt.mode); setOpen(false); }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-[12px] transition-colors text-left",
                  opt.mode === currentMode
                    ? "bg-purple/10 text-foreground"
                    : disabled
                      ? "text-gray/30 cursor-not-allowed"
                      : "text-gray-light hover:bg-muted hover:text-foreground"
                )}
              >
                <opt.icon className="w-3.5 h-3.5" />
                <span className="font-medium">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Recipient Inputs (inline, no labels, compact) ---

function RecipientInput({ output, onUpdate, defaultAddress, selfMeta }: {
  output: OutputRow;
  onUpdate: (update: Partial<OutputRow>) => void;
  defaultAddress: string;
  selfMeta?: StealthMetaAddress | null;
}) {
  if (output.mode === "btc") {
    return (
      <BtcAddressInput
        onValidated={(addr, script) => {
          onUpdate({ btcAddress: addr, btcScriptPubKey: script, btcAddressError: null });
        }}
        validatedAddress={output.btcAddress}
        error={output.btcAddressError}
        onError={(err) => onUpdate({ btcAddressError: err })}
        compact
      />
    );
  }

  if (output.mode === "note") {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const phrase = output.secretPhrase.trim();
    const fullClaimUrl = phrase.length >= 8
      ? `${origin}/claim#note=${encodeURIComponent(phrase)}`
      : "";
    return (
      <div>
        <div className="flex items-center gap-1 mb-1 pl-1">
          <p className="text-[11px] font-mono text-gray/40 truncate flex-1">
            {phrase.length >= 8
              ? `${origin}/claim#note=${encodeURIComponent(phrase)}`
              : `${origin}/claim#note=`}
          </p>
          {fullClaimUrl && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(fullClaimUrl);
              }}
              className="shrink-0 p-1 rounded text-gray/40 hover:text-btc transition-colors cursor-pointer"
              title="Copy claim link"
            >
              <Copy className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="relative">
          <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-btc" />
          <input
            type="text"
            value={output.secretPhrase}
            onChange={(e) => onUpdate({ secretPhrase: e.target.value })}
            placeholder="secret-phrase"
            className={cn(
              "w-full pl-8 pr-3 py-2.5 bg-muted rounded-[8px]",
              "text-body2 font-mono text-foreground placeholder:text-gray/40",
              "outline-none transition-shadow",
              phrase.length >= 8
                ? "ring-1 ring-btc/30"
                : "focus:ring-1 focus:ring-btc/30"
            )}
          />
        </div>
        {phrase.length > 0 && phrase.length < 8 && (
          <p className="text-[10px] text-gray mt-0.5 pl-2">
            {8 - phrase.length} more chars needed
          </p>
        )}
      </div>
    );
  }

  if (output.mode === "stealth") {
    return (
      <StealthRecipientInput
        onResolved={(meta, name) =>
          onUpdate({ resolvedMeta: meta, resolvedName: name })
        }
        resolvedMeta={output.resolvedMeta}
        resolvedName={output.resolvedName}
        error={output.stealthError}
        onError={(err) => onUpdate({ stealthError: err })}
        icon={<Shield className="w-3.5 h-3.5 text-purple" />}
        selfMeta={selfMeta}
        compact
      />
    );
  }

  // Public (Solana) mode
  return (
    <div>
      <div className="relative">
        <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-privacy" />
        <input
          type="text"
          value={output.solanaAddress}
          onChange={(e) => onUpdate({ solanaAddress: e.target.value, addressError: null })}
          placeholder="Solana address..."
          className={cn(
            "w-full pl-8 pr-3 py-2.5 bg-muted rounded-[8px]",
            "text-body2 font-mono text-foreground placeholder:text-gray/40",
            "outline-none transition-shadow",
            output.addressError
              ? "ring-1 ring-error/50"
              : isValidSolanaAddress(output.solanaAddress)
                ? "ring-1 ring-privacy/40"
                : "focus:ring-1 focus:ring-privacy/30"
          )}
        />
      </div>
      {output.addressError && (
        <div className="flex items-center gap-1.5 text-error mt-0.5 pl-2">
          <AlertCircle className="w-3 h-3" />
          <span className="text-[10px]">{output.addressError}</span>
        </div>
      )}
      {output.solanaAddress && isValidSolanaAddress(output.solanaAddress) && (
        <p className="text-[10px] text-privacy pl-2 mt-0.5 flex items-center gap-1">
          <Check className="w-3 h-3" />
          Valid address
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
    <div className="px-2 py-2 rounded-[8px] bg-btc/5 space-y-1">
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
