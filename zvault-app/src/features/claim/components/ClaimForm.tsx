"use client";

import { Shield, Copy, Key, Link2, CheckCircle2, Coins } from "lucide-react";
import { cn } from "@/lib/utils";
import { WalletButton } from "@/components/ui/wallet-button";
import { formatBtc } from "@/lib/utils/formatting";
import { ErrorMessage } from "@/features/shared/components";
import { useClipboard } from "@/features/shared/hooks";
import type { PublicKey } from "@solana/web3.js";
import type { VerifyResult } from "../types";

interface ClaimFormProps {
  secretPhrase: string;
  onSecretPhraseChange: (value: string) => void;
  onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  onPasteFromClipboard: () => void;
  onVerify: () => void;
  onClaim: () => void;
  verifyResult: VerifyResult | null;
  claimLinkUrl: string | null;
  error: string | null;
  connected: boolean;
  publicKey: PublicKey | null;
}

export function ClaimForm({
  secretPhrase,
  onSecretPhraseChange,
  onPaste,
  onPasteFromClipboard,
  onVerify,
  onClaim,
  verifyResult,
  claimLinkUrl,
  error,
  connected,
  publicKey,
}: ClaimFormProps) {
  const { copied, copy } = useClipboard();

  const handleCopyLink = () => {
    if (claimLinkUrl) copy(claimLinkUrl);
  };

  return (
    <div className="space-y-4">
      {/* Privacy info */}
      <div className="flex items-center gap-3 p-3 bg-privacy/10 border border-privacy/20 rounded-[12px]">
        <Shield className="w-5 h-5 text-privacy" />
        <div className="flex flex-col">
          <span className="text-body2-semibold text-privacy">Privacy Preserved</span>
          <span className="text-caption text-privacy opacity-80">
            Amount is looked up on-chain. Your deposit cannot be linked to this claim.
          </span>
        </div>
      </div>

      {/* Paste Link Button */}
      {!secretPhrase && (
        <>
          <button
            onClick={onPasteFromClipboard}
            className="w-full p-3 bg-sol/10 border border-sol/20 rounded-[12px] text-body2 text-sol hover:bg-sol/20 transition-colors flex items-center justify-center gap-2"
          >
            <Copy className="w-4 h-4" />
            Paste Claim Link from Clipboard
          </button>
          <div className="divider-text text-caption text-gray">or enter manually</div>
        </>
      )}

      {/* Secret Phrase Input */}
      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Secret Phrase
        </label>
        <div className="relative">
          <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray" />
          <input
            type="text"
            value={secretPhrase}
            onChange={(e) => onSecretPhraseChange(e.target.value)}
            onPaste={onPaste}
            placeholder="Enter your secret phrase (e.g., alpha-bravo-charlie-1234)"
            className={cn(
              "w-full p-3 pl-10 bg-muted border border-gray/15 rounded-[12px]",
              "text-body2 font-mono text-foreground placeholder:text-gray",
              "outline-none focus:border-privacy/40 transition-colors"
            )}
          />
        </div>
        <p className="text-caption text-gray mt-1 pl-2">
          This is the same secret you used when depositing
        </p>
      </div>

      {/* Shareable Claim Link */}
      {claimLinkUrl && (
        <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
          <div className="flex items-center justify-between mb-2">
            <p className="text-caption text-gray flex items-center gap-1">
              <Link2 className="w-3 h-3" />
              Shareable Claim Link
            </p>
            <button
              onClick={handleCopyLink}
              className="text-caption text-privacy hover:text-success transition-colors flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="p-2 bg-background rounded-[8px] break-all">
            <code className="text-caption font-mono text-gray-light">
              {claimLinkUrl}
            </code>
          </div>
        </div>
      )}

      {/* Verification Result */}
      {verifyResult && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-3 bg-success/10 border border-success/20 rounded-[12px]">
            <CheckCircle2 className="w-5 h-5 text-success" />
            <span className="text-body2 text-success">Claim verified!</span>
          </div>
          <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
            <p className="text-caption text-gray mb-1">Amount to Claim</p>
            <p className="text-heading6 text-privacy">
              {formatBtc(verifyResult.amountSats)} zBTC
            </p>
          </div>
        </div>
      )}

      {/* Recipient Wallet */}
      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Recipient Wallet
        </label>
        {connected && publicKey ? (
          <div className="flex items-center gap-2 p-3 bg-muted border border-privacy/20 rounded-[12px]">
            <div className="w-2 h-2 rounded-full bg-privacy" />
            <span className="text-body2 font-mono text-gray-light">
              {publicKey.toBase58().slice(0, 8)}...{publicKey.toBase58().slice(-8)}
            </span>
          </div>
        ) : (
          <WalletButton className="btn-tertiary w-full justify-center" />
        )}
      </div>

      {/* Error */}
      {error && <ErrorMessage message={error} />}

      {/* Buttons */}
      <div className="space-y-2">
        {!verifyResult && (
          <button
            onClick={onVerify}
            disabled={secretPhrase.trim().length < 8}
            className="btn-secondary w-full"
          >
            <Shield className="w-5 h-5" />
            Verify Claim
          </button>
        )}
        <button
          onClick={onClaim}
          disabled={secretPhrase.trim().length < 8 || !connected}
          className="btn-primary w-full"
        >
          <Coins className="w-5 h-5" />
          Claim zBTC
        </button>
      </div>
    </div>
  );
}
