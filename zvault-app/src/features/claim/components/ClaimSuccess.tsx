"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ExternalLink,
  Shield,
  Gift,
  Copy,
  Key,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBtc } from "@/lib/utils/formatting";
import { useClipboard, useMultiClipboard } from "@/features/shared/hooks";
import type { ClaimResult, SplitResult } from "../types";

interface ClaimSuccessProps {
  result: ClaimResult;
  splitResult: SplitResult | null;
  splitLoading: boolean;
  onSplit: (amount: number) => void;
  onReset: () => void;
}

export function ClaimSuccess({
  result,
  splitResult,
  splitLoading,
  onSplit,
  onReset,
}: ClaimSuccessProps) {
  const [showSplitUI, setShowSplitUI] = useState(false);
  const [splitAmount, setSplitAmount] = useState("");
  const { copy: copyKeep, isCopied: isKeepCopied } = useMultiClipboard(["keep", "send"]);

  const handleSplit = () => {
    const amount = parseInt(splitAmount, 10);
    if (!isNaN(amount)) {
      onSplit(amount);
    }
  };

  const getFullUrl = (link: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/claim?note=${link}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 p-3 bg-success/10 border border-success/20 rounded-[12px]">
        <CheckCircle2 className="w-5 h-5 text-success" />
        <span className="text-body2 text-success">Tokens claimed successfully!</span>
      </div>

      {/* Claim Details */}
      <div className="space-y-3">
        <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
          <p className="text-caption text-gray mb-1">Amount Claimed</p>
          <p className="text-heading6 text-privacy">
            {formatBtc(result.claimedAmount)} zBTC
          </p>
        </div>

        <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
          <p className="text-caption text-gray mb-1">Transaction</p>
          <a
            href={`https://orbmarkets.io/tx/${result.txSignature}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-caption font-mono text-privacy hover:underline break-all flex items-center gap-1"
          >
            {result.txSignature.slice(0, 20)}...{result.txSignature.slice(-20)}
            <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
        </div>

        {/* ZK Proof Details */}
        <div className="p-3 bg-privacy/10 border border-privacy/20 rounded-[12px]">
          <p className="text-caption text-privacy mb-2 flex items-center gap-1">
            <Shield className="w-3 h-3" />
            ZK Proof Verified
          </p>
          <div className="space-y-1 text-caption">
            <div className="flex justify-between">
              <span className="text-gray">Status:</span>
              <span className="text-privacy font-mono">{result.proofStatus}</span>
            </div>
            {result.leafIndex !== undefined && (
              <div className="flex justify-between">
                <span className="text-gray">Leaf Index:</span>
                <span className="text-gray-light font-mono">{result.leafIndex}</span>
              </div>
            )}
            {result.merkleRoot && (
              <div className="flex justify-between">
                <span className="text-gray">Merkle Root:</span>
                <span
                  className="text-gray-light font-mono truncate max-w-[150px]"
                  title={result.merkleRoot}
                >
                  {result.merkleRoot.slice(0, 8)}...{result.merkleRoot.slice(-8)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Split & Send Section */}
      {result.claimedAmount > 1000 && !splitResult && (
        <div className="border-t border-gray/15 pt-4">
          {!showSplitUI ? (
            <button
              onClick={() => setShowSplitUI(true)}
              className="w-full p-3 bg-sol/10 border border-sol/20 rounded-[12px] text-body2 text-sol hover:bg-sol/20 transition-colors flex items-center justify-center gap-2"
            >
              <Gift className="w-4 h-4" />
              Split & Send to Someone
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-body2-semibold text-foreground flex items-center gap-2">
                  <Gift className="w-4 h-4 text-sol" />
                  Split & Send
                </p>
                <button
                  onClick={() => setShowSplitUI(false)}
                  className="text-caption text-gray hover:text-gray-light transition-colors"
                >
                  Cancel
                </button>
              </div>

              <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
                <p className="text-caption text-gray mb-2">Amount to Send (sats)</p>
                <input
                  type="number"
                  value={splitAmount}
                  onChange={(e) => setSplitAmount(e.target.value)}
                  placeholder="0"
                  min="1000"
                  max={result.claimedAmount - 1000}
                  className={cn(
                    "w-full p-2 bg-background border border-gray/20 rounded-[8px]",
                    "text-body2 font-mono text-foreground placeholder:text-gray",
                    "outline-none focus:border-sol/40 transition-colors"
                  )}
                />
                <div className="flex justify-between mt-2 text-caption text-gray">
                  <span>Min: 1,000 sats</span>
                  <span>Max: {(result.claimedAmount - 1000).toLocaleString()} sats</span>
                </div>
              </div>

              {splitAmount && parseInt(splitAmount, 10) > 0 && parseInt(splitAmount, 10) < result.claimedAmount && (
                <div className="p-3 bg-sol/10 border border-sol/20 rounded-[12px]">
                  <div className="flex justify-between text-caption mb-1">
                    <span className="text-gray">You keep:</span>
                    <span className="text-foreground">
                      {formatBtc(result.claimedAmount - parseInt(splitAmount, 10))} zBTC
                    </span>
                  </div>
                  <div className="flex justify-between text-caption">
                    <span className="text-gray">Send to friend:</span>
                    <span className="text-sol">{formatBtc(parseInt(splitAmount, 10))} zBTC</span>
                  </div>
                </div>
              )}

              <button
                onClick={handleSplit}
                disabled={
                  splitLoading ||
                  !splitAmount ||
                  parseInt(splitAmount, 10) <= 0 ||
                  parseInt(splitAmount, 10) >= result.claimedAmount
                }
                className="btn-secondary w-full"
              >
                {splitLoading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating...
                  </span>
                ) : (
                  <>
                    <Gift className="w-4 h-4" />
                    Generate Claim Links
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Split Result */}
      {splitResult && (
        <div className="border-t border-gray/15 pt-4 space-y-3">
          <p className="text-body2-semibold text-success flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Split Complete!
          </p>

          {/* Your Link */}
          <div className="p-3 bg-privacy/10 border border-privacy/20 rounded-[12px]">
            <div className="flex items-center justify-between mb-2">
              <p className="text-caption text-privacy flex items-center gap-1">
                <Key className="w-3 h-3" />
                Your Link ({formatBtc(splitResult.keepAmount)})
              </p>
              <button
                onClick={() => copyKeep("keep", getFullUrl(splitResult.keepLink))}
                className="text-caption text-privacy hover:text-success transition-colors flex items-center gap-1"
              >
                <Copy className="w-3 h-3" />
                {isKeepCopied("keep") ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="p-2 bg-background rounded-[8px]">
              <code className="text-caption font-mono text-gray-light break-all">
                {getFullUrl(splitResult.keepLink.slice(0, 30))}...
              </code>
            </div>
          </div>

          {/* Send Link */}
          <div className="p-3 bg-sol/10 border border-sol/20 rounded-[12px]">
            <div className="flex items-center justify-between mb-2">
              <p className="text-caption text-sol flex items-center gap-1">
                <Gift className="w-3 h-3" />
                Send to Friend ({formatBtc(splitResult.sendAmount)})
              </p>
              <button
                onClick={() => copyKeep("send", getFullUrl(splitResult.sendLink))}
                className="text-caption text-sol hover:text-success transition-colors flex items-center gap-1"
              >
                <Copy className="w-3 h-3" />
                {isKeepCopied("send") ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="p-2 bg-background rounded-[8px]">
              <code className="text-caption font-mono text-gray-light break-all">
                {getFullUrl(splitResult.sendLink.slice(0, 30))}...
              </code>
            </div>
            <p className="text-caption text-gray mt-2">
              Share this link with the person you want to send zBTC to!
            </p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2">
        <Link href="/bridge" className="btn-primary w-full">
          Back to Bridge
        </Link>
        <button onClick={onReset} className="btn-tertiary w-full">
          Claim Another
        </button>
      </div>
    </div>
  );
}
