"use client";

import { useZVaultKeys } from "@/hooks/use-zvault";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * Component to display and manage stealth address
 *
 * Shows:
 * - Connect wallet prompt if not connected
 * - Derive keys button if connected but no keys
 * - Stealth address with copy button if keys derived
 */
export function StealthAddressCard() {
  const wallet = useWallet();
  const {
    keys,
    stealthAddressEncoded,
    isLoading,
    error,
    deriveKeys,
  } = useZVaultKeys();
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
          Sign a message with your wallet to derive your private zVault keys.
          This signature is used to generate your stealth address.
        </p>
        {error && (
          <p className="text-red-400 text-sm mb-4">{error}</p>
        )}
        <button
          onClick={deriveKeys}
          disabled={isLoading}
          className="w-full py-2 px-4 bg-orange-500 hover:bg-orange-600 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {isLoading ? "Signing..." : "Derive Keys"}
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
export function StealthAddressBadge() {
  const { keys, stealthAddressEncoded, deriveKeys, isLoading } = useZVaultKeys();
  const { copy, copied } = useCopyToClipboard();

  if (!keys) {
    return (
      <button
        onClick={deriveKeys}
        disabled={isLoading}
        className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors"
      >
        {isLoading ? "..." : "Derive Keys"}
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
