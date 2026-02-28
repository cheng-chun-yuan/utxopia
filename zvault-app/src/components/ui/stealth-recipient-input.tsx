"use client";

import { useState, useCallback } from "react";
import { Key, Check, AlertCircle, Info, Loader2, Globe } from "lucide-react";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import {
  decodeStealthMetaAddress,
  resolveSnsName,
  getConfig,
  type StealthMetaAddress,
} from "@zvault/sdk";

type RecipientType = "btcpro" | "address";

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
  const [recipientType, setRecipientType] = useState<RecipientType>("btcpro");
  const [recipient, setRecipient] = useState("");
  const [resolving, setResolving] = useState(false);

  const config = getConfig();
  const parentDomain = config.snsParentDomain || "btcpro";

  // Resolve recipient
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
      if (recipientType === "btcpro") {
        // Resolve via SNS subdomain
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

        // Convert SnsStealthAddress → StealthMetaAddress
        // mpk is zero because senders don't need it
        const meta: StealthMetaAddress = {
          spendingPubKey: result.spendingPubKey,
          viewingPubKey: result.viewingPubKey,
          mpk: new Uint8Array(32),
        };
        onResolved(meta, `${subdomain}.${parentDomain}.sol`);
      } else {
        // Parse raw stealth address (hex encoded)
        const meta = decodeStealthMetaAddress(trimmed);
        if (!meta) {
          onError("Invalid stealth address format (expected 130 hex characters)");
          return;
        }
        onResolved(meta, null);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to resolve recipient");
    } finally {
      setResolving(false);
    }
  }, [recipient, recipientType, onResolved, onError, parentDomain]);

  const handleInputChange = (value: string) => {
    setRecipient(value);
    onResolved(null, null);
    onError(null);
  };

  const handleTypeChange = (type: RecipientType) => {
    setRecipientType(type);
    setRecipient("");
    onResolved(null, null);
    onError(null);
  };

  const getPlaceholder = () => {
    switch (recipientType) {
      case "btcpro": return "alice";
      case "address": return "130 hex characters";
    }
  };

  const getLabel = () => {
    switch (recipientType) {
      case "btcpro": return `Recipient .${parentDomain}.sol Name`;
      case "address": return "Recipient Stealth Address";
    }
  };

  const getSuffix = () => {
    switch (recipientType) {
      case "btcpro": return `.${parentDomain}.sol`;
      default: return null;
    }
  };

  const getResolvedLabel = () => {
    if (!resolvedName) return "Valid stealth address";
    return `${resolvedName} resolved`;
  };

  const suffix = getSuffix();

  return (
    <div className={className}>
      {/* Recipient Type Toggle */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => handleTypeChange("btcpro")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[8px] text-caption transition-colors",
            recipientType === "btcpro"
              ? "bg-purple/15 text-purple border border-purple/30"
              : "bg-muted text-gray border border-gray/15 hover:text-gray-light"
          )}
        >
          <Globe className="w-3.5 h-3.5" />
          .{parentDomain}.sol
          <Tooltip content={`A Solana Name Service subdomain (like alice.${parentDomain}.sol) with embedded stealth address keys.`}>
            <Info className="w-3 h-3 opacity-60" />
          </Tooltip>
        </button>
        <button
          onClick={() => handleTypeChange("address")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[8px] text-caption transition-colors",
            recipientType === "address"
              ? "bg-purple/15 text-purple border border-purple/30"
              : "bg-muted text-gray border border-gray/15 hover:text-gray-light"
          )}
        >
          <Key className="w-3.5 h-3.5" />
          Address
        </button>
      </div>

      {/* Recipient Input */}
      <div className="mb-2">
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          {getLabel()}
        </label>
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <input
              type="text"
              value={recipient}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder={getPlaceholder()}
              className={cn(
                "w-full px-4 py-3 bg-muted border rounded-[10px]",
                "text-body2 font-mono text-foreground placeholder:text-gray/40",
                "outline-none transition-colors",
                error
                  ? "border-red-500/50"
                  : resolvedMeta
                    ? "border-privacy/40"
                    : "border-gray/20 focus:border-purple/40",
                suffix ? "pr-28" : ""
              )}
            />
            {suffix && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-body2 text-gray">{suffix}</span>
            )}
          </div>
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
          {recipientType === "btcpro" && resolvedName ? (
            <>
              <Globe className="w-3 h-3" />
              {getResolvedLabel()}
            </>
          ) : (
            "Valid stealth address"
          )}
        </p>
      )}
    </div>
  );
}
