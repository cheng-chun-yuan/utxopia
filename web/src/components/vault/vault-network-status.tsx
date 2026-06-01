"use client";

interface VaultNetworkStatusProps {
  bitcoinNetworkLabel: string;
  solanaNetworkLabel: string;
}

export function VaultNetworkStatus({
  bitcoinNetworkLabel,
  solanaNetworkLabel,
}: VaultNetworkStatusProps) {
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <div className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
      <span className="text-[11px] text-gray/40">
        Bitcoin {bitcoinNetworkLabel} · Solana {solanaNetworkLabel}
      </span>
    </div>
  );
}
