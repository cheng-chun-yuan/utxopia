"use client";

import { useState, useCallback } from "react";
import { Tag, Key, Check, AlertCircle, Info, Loader2 } from "lucide-react";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import {
  decodeStealthMetaAddress,
  lookupZkeyName,
  type StealthMetaAddress,
} from "@zvault/sdk";

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
  const [recipientType, setRecipientType] = useState<"zkey" | "address">("zkey");
  const [recipient, setRecipient] = useState("");
  const [resolving, setResolving] = useState(false);

  // Resolve recipient (zkey name or stealth address)
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

      if (recipientType === "zkey" || (!isLikelyHex && recipientType === "address")) {
        // Lookup .zkey.sol name on custom name registry
        const name = trimmed.replace(/\.zkey\.sol$/i, "").replace(/\.zkey$/i, "");
        const connectionAdapter = getConnectionAdapter();
        const result = await lookupZkeyName(connectionAdapter as any, name);
        if (!result) {
          // If in address mode, also try as hex
          if (recipientType === "address") {
            const meta = decodeStealthMetaAddress(trimmed);
            if (meta) {
              onResolved(meta, null);
              return;
            }
          }
          onError(`"${name}.zkey.sol" not found`);
          return;
        }
        onResolved(result, name);
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
  }, [recipient, recipientType, onResolved, onError]);

  const handleInputChange = (value: string) => {
    setRecipient(value);
    onResolved(null, null);
    onError(null);
  };

  const handleTypeChange = (type: "zkey" | "address") => {
    setRecipientType(type);
    setRecipient("");
    onResolved(null, null);
    onError(null);
  };

  return (
    <div className={className}>
      {/* Recipient Type Toggle */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => handleTypeChange("zkey")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[8px] text-caption transition-colors",
            recipientType === "zkey"
              ? "bg-purple/15 text-purple border border-purple/30"
              : "bg-muted text-gray border border-gray/15 hover:text-gray-light"
          )}
        >
          <Tag className="w-3.5 h-3.5" />
          .zkey.sol Name
          <Tooltip content="A human-readable name (like alice.zkey.sol) that maps to a stealth address via Solana Name Service.">
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
          Stealth Address
        </button>
      </div>

      {/* Recipient Input */}
      <div className="mb-2">
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          {recipientType === "zkey" ? "Recipient .zkey.sol Name" : "Recipient Stealth Address"}
        </label>
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <input
              type="text"
              value={recipient}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder={recipientType === "zkey" ? "alice" : "130 hex characters"}
              className={cn(
                "w-full px-4 py-3 bg-muted border rounded-[10px]",
                "text-body2 font-mono text-foreground placeholder:text-gray/40",
                "outline-none transition-colors",
                error
                  ? "border-red-500/50"
                  : resolvedMeta
                    ? "border-privacy/40"
                    : "border-gray/20 focus:border-purple/40",
                recipientType === "zkey" ? "pr-20" : ""
              )}
            />
            {recipientType === "zkey" && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-body2 text-gray">.zkey.sol</span>
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
  );
}
