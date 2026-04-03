"use client";

import { useAegisKeys } from "@/hooks/use-privacy-coin";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Key, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Component to display and manage stealth address
 *
 * Shows:
 * - Connect wallet prompt if not connected
 * - Unlock Vault button if connected but no keys
 * - Stealth address with copy button if keys derived
 */
export function StealthAddressCard({ onUnlock }: { onUnlock?: () => void }) {
  const wallet = useWallet();
  const {
    keys,
    stealthAddressEncoded,
    isLoading,
    error,
  } = useAegisKeys();
  const { copy, copied } = useCopyToClipboard();

  // Not connected
  if (!wallet.connected) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="text-lg font-medium text-white mb-2">Stealth Address</h3>
        <p className="text-zinc-400 text-sm mb-4">
          Connect your Solana wallet to generate a private stealth address.
        </p>
        <button
          onClick={() => wallet.connect()}
          className="w-full py-2 px-4 bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  // Connected but no keys
  if (!keys) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="text-lg font-medium text-white mb-2">Stealth Address</h3>
        <p className="text-zinc-400 text-sm mb-4">
          Unlock your vault to access your private stealth address.
        </p>
        {error && (
          <p className="text-red-400 text-sm mb-4">{error}</p>
        )}
        <button
          onClick={onUnlock}
          disabled={isLoading}
          className={cn(
            "w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-lg transition-colors",
            "bg-privacy hover:bg-privacy/80 text-background font-medium",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          <Key className="w-4 h-4" />
          {isLoading ? "Unlocking..." : "Unlock Vault"}
        </button>
      </div>
    );
  }

  // Keys derived - show stealth address
  const shortAddress = stealthAddressEncoded
    ? `${stealthAddressEncoded.slice(0, 12)}...${stealthAddressEncoded.slice(-12)}`
    : "";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
      <h3 className="text-lg font-medium text-white mb-2">Your Stealth Address</h3>
      <p className="text-zinc-400 text-sm mb-4">
        Share this address to receive private payments.
      </p>

      <div className="flex items-center gap-2 p-3 bg-zinc-800 rounded-lg">
        <code className="flex-1 text-sm text-zinc-300 font-mono truncate">
          {shortAddress}
        </code>
        <button
          onClick={() => copy(stealthAddressEncoded || "")}
          className="px-3 py-1 text-sm bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      <div className="mt-4 pt-4 border-t border-zinc-800">
        <p className="text-zinc-500 text-xs">
          Keys are stored in memory only and cleared when you disconnect.
        </p>
      </div>
    </div>
  );
}

/**
 * Compact version for header/nav
 */
export function StealthAddressBadge({ onUnlock }: { onUnlock?: () => void }) {
  const { keys, stealthAddressEncoded, isLoading } = useAegisKeys();
  const { copy, copied } = useCopyToClipboard();

  if (!keys) {
    return (
      <button
        onClick={onUnlock}
        disabled={isLoading}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors",
          "bg-privacy/10 hover:bg-privacy/20 text-privacy"
        )}
      >
        <Key className="w-3.5 h-3.5" />
        {isLoading ? "..." : "Unlock"}
      </button>
    );
  }

  const shortAddress = stealthAddressEncoded
    ? `${stealthAddressEncoded.slice(0, 6)}...${stealthAddressEncoded.slice(-4)}`
    : "";

  return (
    <button
      onClick={() => copy(stealthAddressEncoded || "")}
      className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors font-mono"
      title={copied ? "Copied!" : "Click to copy stealth address"}
    >
      {copied ? "Copied!" : shortAddress}
    </button>
  );
}
