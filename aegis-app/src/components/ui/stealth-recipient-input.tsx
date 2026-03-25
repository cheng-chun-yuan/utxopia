"use client";

import { useState, useCallback } from "react";
import { Check, AlertCircle, Globe, UserRound } from "lucide-react";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import { cn } from "@/lib/utils";
import {
  decodeStealthMetaAddress,
  encodeStealthMetaAddress,
  resolveSnsName,
  getConfig,
  type StealthMetaAddress,
} from "@aegis/sdk";

interface StealthRecipientInputProps {
  onResolved: (meta: StealthMetaAddress | null, name: string | null) => void;
  resolvedMeta: StealthMetaAddress | null;
  resolvedName: string | null;
  error: string | null;
  onError: (error: string | null) => void;
  className?: string;
  icon?: React.ReactNode;
  /** If provided, shows a "Self" button to auto-fill with own stealth address */
  selfMeta?: StealthMetaAddress | null;
  /** Compact mode: no label, tighter padding */
  compact?: boolean;
}

export function StealthRecipientInput({
  onResolved,
  resolvedMeta,
  resolvedName,
  error,
  onError,
  className,
  icon,
  selfMeta,
  compact = false,
}: StealthRecipientInputProps) {
  const [recipient, setRecipient] = useState("");
  const [resolvedInput, setResolvedInput] = useState(""); // the input value that was resolved
  const [resolving, setResolving] = useState(false);

  const config = getConfig();
  const parentDomain = config.snsParentDomain || "btcpro";

  // resolvedMeta is only valid when current input matches what was resolved
  const isValid = !!resolvedMeta && recipient.trim() === resolvedInput;

  // Auto-detect: long hex = stealth address, otherwise = .btcpro.sol name
  const resolveRecipient = useCallback(async () => {
    if (!recipient.trim()) {
      onError("Please enter a recipient");
      return;
    }

    setResolving(true);
    onError(null);
    onResolved(null, null);

    const trimmed = recipient.trim();

    try {
      // Reject URLs
      if (/^https?:\/\//i.test(trimmed)) {
        onError("Please enter a .btcpro.sol name or stealth address, not a URL");
        return;
      }

      // Reject Bitcoin addresses (bc1/tb1/1/3/n/m prefixed)
      if (/^(bc1|tb1|[13nm])[a-zA-HJ-NP-Z0-9]{25,}$/i.test(trimmed)) {
        onError("Please enter a .btcpro.sol name or stealth address, not a BTC address");
        return;
      }

      // Detect stealth address: aegis: prefix or long hex (50+ chars)
      const isStealthAddress = trimmed.startsWith("aegis:") || /^[0-9a-fA-F]{50,}$/.test(trimmed);

      if (isStealthAddress) {
        const meta = decodeStealthMetaAddress(trimmed);
        if (!meta) {
          const short = trimmed.length > 20
            ? `${trimmed.slice(0, 10)}...${trimmed.slice(-6)}`
            : trimmed;
          onError(`Invalid stealth address: ${short}`);
          return;
        }
        setResolvedInput(trimmed);
        onResolved(meta, null);
        return;
      }

      // Reject Solana pubkeys (base58, 32-44 chars)
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
        onError("Enter a .btcpro.sol name or stealth address, not a Solana address");
        return;
      }

      // Otherwise treat as .btcpro.sol name — must be alphanumeric/hyphen only
      const subdomain = trimmed
        .replace(new RegExp(`\\.${parentDomain}\\.sol$`, "i"), "")
        .replace(new RegExp(`\\.${parentDomain}$`, "i"), "")
        .toLowerCase();

      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain) || subdomain.length < 1) {
        onError(`Invalid name — enter a .${parentDomain}.sol name or aegis: stealth address`);
        return;
      }

      if (subdomain.length > 32) {
        onError("Name too long — expected a short .btcpro.sol subdomain");
        return;
      }

      const connectionAdapter = getConnectionAdapter();
      const result = await resolveSnsName(connectionAdapter as any, subdomain);
      if (!result) {
        const displayName = subdomain.length > 20
          ? `${subdomain.slice(0, 10)}...${subdomain.slice(-6)}`
          : subdomain;
        onError(`"${displayName}.${parentDomain}.sol" not found`);
        return;
      }

      const meta: StealthMetaAddress = {
        spendingPubKey: new Uint8Array(32),
        viewingPubKey: result.viewingPubKey,
        mpk: result.mpk,
      };
      setResolvedInput(trimmed);
      onResolved(meta, `${subdomain}.${parentDomain}.sol`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to resolve recipient");
    } finally {
      setResolving(false);
    }
  }, [recipient, onResolved, onError, parentDomain]);

  const handleInputChange = (value: string) => {
    setRecipient(value);
    onResolved(null, null);
    onError(null);
  };

  return (
    <div className={className}>
      {/* Recipient Input */}
      <div className={compact ? "" : "mb-2"}>
        {!compact && (
          <label className="text-body2 text-gray-light pl-2 mb-2 block">
            Recipient
          </label>
        )}
        <div className="relative">
          {icon && (
            <div className={cn("absolute top-1/2 -translate-y-1/2", compact ? "left-3" : "left-4")}>
              {icon}
            </div>
          )}
          <input
            type="text"
            value={recipient}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={`alice.${parentDomain}.sol or aegis:...`}
            className={cn(
              "w-full bg-muted text-body2 font-mono text-foreground placeholder:text-gray/40 outline-none transition-shadow",
              compact ? "py-2.5 rounded-[8px]" : "py-3 rounded-[10px] border border-gray/20 focus:border-purple/40",
              icon ? (compact ? "pl-8" : "pl-10") : (compact ? "pl-3" : "pl-4"),
              "pr-12",
              compact
                ? error
                  ? "ring-1 ring-red-500/50"
                  : isValid
                    ? "ring-1 ring-privacy/40"
                    : "focus:ring-1 focus:ring-purple/30"
                : error
                  ? "border-red-500/50"
                  : isValid
                    ? "border-privacy/40"
                    : ""
            )}
            onBlur={() => {
              // Only auto-resolve stealth addresses (aegis: prefix or long hex)
              // SNS names require explicit Enter/button to avoid false positives
              const trimmed = recipient.trim();
              const isStealthFormat = trimmed.startsWith("aegis:") || /^[0-9a-fA-F]{50,}$/.test(trimmed);
              if (isStealthFormat && !resolvedMeta && !resolving) {
                resolveRecipient();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && recipient.trim() && !resolving) {
                resolveRecipient();
              }
            }}
          />
          {!isValid && (
            <button
              type="button"
              disabled={!selfMeta}
              onClick={() => {
                if (!selfMeta) return;
                const encoded = encodeStealthMetaAddress(selfMeta);
                setRecipient(encoded);
                setResolvedInput(encoded);
                onResolved(selfMeta, null);
                onError(null);
              }}
              className={cn(
                "absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md border transition-colors",
                selfMeta
                  ? "bg-purple/10 hover:bg-purple/20 border-purple/20 cursor-pointer"
                  : "bg-gray/5 border-gray/15 cursor-not-allowed opacity-40"
              )}
              title={selfMeta ? "Fill with your stealth address" : "Connect wallet to use your address"}
            >
              <UserRound className={cn("w-3.5 h-3.5", selfMeta ? "text-purple" : "text-gray")} />
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && !isValid && (
        <div className="flex items-start gap-2 text-red-400 pl-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="text-caption break-all">{error}</span>
        </div>
      )}

      {/* Resolved */}
      {isValid && (
        <p className="text-caption text-privacy pl-2 flex items-center gap-1">
          <Check className="w-3.5 h-3.5" />
          {resolvedName ? (
            <>
              <Globe className="w-3 h-3" />
              {resolvedName} resolved
            </>
          ) : (
            "Valid stealth address"
          )}
        </p>
      )}
    </div>
  );
}
