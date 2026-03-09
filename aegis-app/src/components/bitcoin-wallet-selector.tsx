"use client";

import { useBitcoinWallet } from "@/stores/bitcoin-wallet-store";
import type { BtcWalletType } from "@/stores/bitcoin-wallet-store";
import { Spinner } from "@/components/ui/spinner";
import { truncateMiddle } from "@/lib/utils/formatting";
import { useIsMobileWithoutWallet } from "@/hooks/use-mobile-wallet-detect";

interface BitcoinWalletSelectorProps {
  onConnect?: () => void;
  onError?: (error: string) => void;
  className?: string;
}

export function BitcoinWalletSelector({
  onConnect,
  onError,
  className = "",
}: BitcoinWalletSelectorProps) {
  const { connected, connecting, address, connect, disconnect, error } =
    useBitcoinWallet();
  const isMobileNoWallet = useIsMobileWithoutWallet();

  const handleConnect = async (type: BtcWalletType) => {
    try {
      await connect(type);
      onConnect?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      onError?.(message);
    }
  };

  if (connected && address) {
    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <div className="flex items-center gap-2 px-3 py-2 bg-btc/10 border border-btc/20 rounded-[8px]">
          <BitcoinIcon className="w-4 h-4" />
          <span className="text-body2 font-mono text-btc">
            {truncateMiddle(address, 4)}
          </span>
        </div>
        <button
          onClick={disconnect}
          className="px-3 py-2 text-caption text-gray hover:text-foreground transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (isMobileNoWallet) {
    return (
      <div className={className}>
        <MobileWalletGuidance />
        {error && (
          <div className="warning-box mt-2">
            <span>⚠</span>
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex gap-2">
        <button
          onClick={() => handleConnect("sats-connect")}
          disabled={connecting}
          className="btn-primary flex-1"
        >
          {connecting ? (
            <>
              <Spinner />
              <span>Connecting...</span>
            </>
          ) : (
            <>
              <BitcoinIcon className="w-5 h-5" />
              <span>Xverse / Leather</span>
            </>
          )}
        </button>
        <button
          onClick={() => handleConnect("unisat")}
          disabled={connecting}
          className="btn-primary flex-1"
          style={{ backgroundColor: "#eb4b13" }}
        >
          {connecting ? (
            <>
              <Spinner />
              <span>Connecting...</span>
            </>
          ) : (
            <>
              <BitcoinIcon className="w-5 h-5" />
              <span>UniSat</span>
            </>
          )}
        </button>
      </div>
      {error && (
        <div className="warning-box mt-2">
          <span>⚠</span>
          {error}
        </div>
      )}
    </div>
  );
}

export function MobileWalletGuidance() {
  const currentUrl = typeof window !== "undefined" ? window.location.href : "";
  const xverseUrl = `https://connect.xverse.app/browser?url=${encodeURIComponent(currentUrl)}`;

  return (
    <div className="p-4 bg-btc/5 border border-btc/20 rounded-[12px] space-y-3">
      <div className="flex items-center gap-2">
        <BitcoinIcon className="w-5 h-5" />
        <span className="text-body2-semibold text-foreground">Mobile Wallet Required</span>
      </div>
      <p className="text-caption text-gray">
        To sign BTC deposit transactions, open this page in your wallet&apos;s built-in browser.
      </p>
      <a
        href={xverseUrl}
        className="w-full py-2.5 rounded-[10px] font-medium transition-colors flex items-center justify-center gap-2 bg-btc hover:bg-btc/90 text-background text-body2"
      >
        <BitcoinIcon className="w-4 h-4" />
        Open in Xverse
      </a>
      <p className="text-[11px] text-gray text-center">
        Or open your Xverse / Leather app, tap the browser icon, and navigate to this page.
      </p>
    </div>
  );
}

export function BitcoinIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.546z" fill="#F7931A"/>
      <path d="M17.27 10.165c.24-1.59-.973-2.446-2.63-3.017l.538-2.155-1.313-.327-.523 2.098c-.345-.086-.7-.167-1.053-.248l.527-2.112-1.312-.328-.537 2.155c-.286-.065-.567-.13-.84-.197l.001-.006-1.811-.452-.35 1.403s.973.223.953.237c.532.133.628.485.612.764l-.614 2.46c.037.009.084.023.137.044l-.14-.035-.86 3.447c-.064.16-.228.4-.598.308.013.02-.954-.238-.954-.238l-.652 1.503 1.71.426c.318.08.63.164.937.242l-.543 2.18 1.312.327.537-2.156c.358.097.705.187 1.045.272l-.535 2.143 1.313.328.543-2.177c2.238.423 3.92.253 4.63-1.772.57-1.631-.029-2.573-1.207-3.188.859-.198 1.506-.763 1.678-1.932zm-3.004 4.213c-.404 1.628-3.14.748-4.028.527l.72-2.883c.888.222 3.728.66 3.308 2.356zm.405-4.238c-.37 1.48-2.646.728-3.385.544l.652-2.614c.74.184 3.117.528 2.733 2.07z" fill="#FFF"/>
    </svg>
  );
}
