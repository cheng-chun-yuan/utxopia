"use client";

import { useState, useCallback } from "react";
import { Check, AlertCircle, Loader2, Globe } from "lucide-react";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import { cn } from "@/lib/utils";
import {
  decodeStealthMetaAddress,
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
}

export function StealthRecipientInput({
  onResolved,
  resolvedMeta,
  resolvedName,
  error,
  onError,
  className,
}: StealthRecipientInputProps) {
  const [recipient, setRecipient] = useState("");
  const [resolving, setResolving] = useState(false);

  const config = getConfig();
  const parentDomain = config.snsParentDomain || "btcpro";

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
      const isLikelyHex = /^[0-9a-fA-F]{100,}$/.test(trimmed);

      if (isLikelyHex) {
        const meta = decodeStealthMetaAddress(trimmed);
        if (!meta) {
          onError("Invalid stealth address format (expected 130 hex characters)");
          return;
        }
        onResolved(meta, null);
        return;
      }

      // Otherwise treat as .btcpro.sol name
      const subdomain = trimmed
        .replace(new RegExp(`\\.${parentDomain}\\.sol$`, "i"), "")
        .replace(new RegExp(`\\.${parentDomain}$`, "i"), "")
        .toLowerCase();

      const connectionAdapter = getConnectionAdapter();
      const result = await resolveSnsName(connectionAdapter as any, subdomain);
      if (!result) {
        onError(`"${subdomain}.${parentDomain}.sol" not found`);
        return;
      }

      const meta: StealthMetaAddress = {
        spendingPubKey: new Uint8Array(32),
        viewingPubKey: result.viewingPubKey,
        mpk: result.mpk,
      };
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
      <div className="mb-2">
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Recipient
        </label>
        <div className="flex gap-3">
          <input
            type="text"
            value={recipient}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={`alice.${parentDomain}.sol or stealth address`}
            className={cn(
              "flex-1 px-4 py-3 bg-muted border rounded-[10px]",
              "text-body2 font-mono text-foreground placeholder:text-gray/40",
              "outline-none transition-colors",
              error
                ? "border-red-500/50"
                : resolvedMeta
                  ? "border-privacy/40"
                  : "border-gray/20 focus:border-purple/40"
            )}
          />
          <button
            onClick={resolveRecipient}
            disabled={!recipient.trim() || resolving}
            className={cn(
              "px-4 py-3 rounded-[10px] text-body2 transition-colors",
              "bg-purple hover:bg-purple/80 text-white",
              "disabled:bg-gray/30 disabled:text-gray disabled:cursor-not-allowed"
            )}
          >
            {resolving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Resolve"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && !resolvedMeta && (
        <div className="flex items-center gap-2 text-red-400 pl-2">
          <AlertCircle className="w-3.5 h-3.5" />
          <span className="text-caption">{error}</span>
        </div>
      )}

      {/* Resolved */}
      {resolvedMeta && (
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
