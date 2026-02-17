"use client";

import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Search, Shield, CheckCircle2, AlertCircle, Copy, Check,
  RefreshCw, ExternalLink, Loader2, Upload
} from "lucide-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { WalletButton } from "@/components/ui/wallet-button";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import {
  getTransactionInfo,
  getBlockHeader,
  getMerkleProof,
  getTipHeight,
  type BlockHeader,
  type MerkleProof,
  type TransactionInfo,
} from "@/lib/spv/mempool";
import { formatBlockHeaderForChain, formatMerkleProofForChain } from "@/lib/spv/verify";
import { zBTCApi } from "@/lib/api/client";

interface VerificationData {
  txInfo: TransactionInfo;
  blockHeader: BlockHeader;
  merkleProof: MerkleProof;
  confirmations: number;
}

export function ManualVerify() {
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();

  // Input state
  const [taprootAddress, setTaprootAddress] = useState("");
  const [txid, setTxid] = useState("");

  // Verification state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationData, setVerificationData] = useState<VerificationData | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Block header submission state
  const [headerSubmitting, setHeaderSubmitting] = useState(false);
  const [headerSubmitted, setHeaderSubmitted] = useState(false);
  const [headerTxSig, setHeaderTxSig] = useState<string | null>(null);

  // Fetch transaction info by address
  const handleLookupAddress = useCallback(async () => {
    if (!taprootAddress.trim()) {
      setError("Please enter a taproot address");
      return;
    }

    setLoading(true);
    setError(null);
    setVerificationData(null);

    try {
      // Fetch transactions for address from mempool.space
      const response = await fetch(
        `https://mempool.space/testnet/api/address/${taprootAddress}/txs`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch address transactions");
      }

      const txs = await response.json();

      if (txs.length === 0) {
        setError("No transactions found for this address");
        return;
      }

      // Find incoming transaction (deposit)
      let depositTxid: string | null = null;
      for (const tx of txs) {
        for (const vout of tx.vout) {
          if (vout.scriptpubkey_address === taprootAddress) {
            depositTxid = tx.txid;
            break;
          }
        }
        if (depositTxid) break;
      }

      if (!depositTxid) {
        setError("No deposit transaction found");
        return;
      }

      setTxid(depositTxid);
      await fetchVerificationData(depositTxid);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }, [taprootAddress]);

  // Fetch verification data by txid
  const handleLookupTxid = useCallback(async () => {
    if (!txid.trim()) {
      setError("Please enter a transaction ID");
      return;
    }

    setLoading(true);
    setError(null);
    await fetchVerificationData(txid.trim());
    setLoading(false);
  }, [txid]);

  // Core function to fetch all verification data
  const fetchVerificationData = async (transactionId: string) => {
    try {
      console.log("[Verify] Fetching data for txid:", transactionId);

      // Get transaction info
      const txInfo = await getTransactionInfo(transactionId, "testnet");

      if (!txInfo.confirmed || !txInfo.blockHash) {
        setError("Transaction not confirmed yet");
        return;
      }

      // Get block header
      const blockHeader = await getBlockHeader(txInfo.blockHash, "testnet");

      // Get merkle proof
      const merkleProof = await getMerkleProof(transactionId, "testnet");
      merkleProof.blockHash = txInfo.blockHash;

      // Get confirmations
      const tipHeight = await getTipHeight("testnet");
      const confirmations = tipHeight - txInfo.blockHeight! + 1;

      setVerificationData({
        txInfo,
        blockHeader,
        merkleProof,
        confirmations,
      });

      console.log("[Verify] Data fetched:", {
        blockHeight: blockHeader.height,
        confirmations,
        merkleProofLength: merkleProof.merkleProof.length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch verification data");
    }
  };

  // Copy to clipboard
  const copyToClipboard = useCallback(async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  // Submit block header to Solana via relayer
  const handleSubmitBlockHeader = useCallback(async () => {
    if (!verificationData) {
      setError("No verification data");
      return;
    }

    setHeaderSubmitting(true);
    setError(null);

    try {
      const header = verificationData.blockHeader;
      console.log("[Header] Submitting block header via relayer...");
      console.log("[Header] Height:", header.height);
      console.log("[Header] Hash:", header.hash);

      // Call relayer API to publish header on-chain
      const result = await zBTCApi.submitHeader(
        header.height,
        header.hash,
        header.rawHeader,
        header.previousBlockHash,
        header.merkleRoot,
        header.timestamp,
        header.bits,
        header.nonce
      );

      if (result.success) {
        setHeaderTxSig(result.solana_tx_signature || null);
        setHeaderSubmitted(true);
        console.log("[Header] Block header submitted:", result.solana_tx_signature);

        if (result.already_exists) {
          console.log("[Header] Header already existed on-chain");
        }
      } else {
        throw new Error(result.error || result.message || "Failed to submit header");
      }
    } catch (err) {
      console.error("[Header] Submission failed:", err);
      setError(err instanceof Error ? err.message : "Failed to submit block header");
    } finally {
      setHeaderSubmitting(false);
    }
  }, [verificationData]);

  // Format data for display
  const getFormattedHeaderData = () => {
    if (!verificationData) return null;
    return formatBlockHeaderForChain(verificationData.blockHeader);
  };

  const getFormattedProofData = () => {
    if (!verificationData || !txid) return null;
    return formatMerkleProofForChain(txid, verificationData.merkleProof);
  };

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-[10px] bg-privacy/10 border border-privacy/20 pulse-glow">
          <Shield className="w-5 h-5 text-privacy privacy-glow" />
        </div>
        <div>
          <p className="text-body2-semibold text-foreground">Manual SPV Verification</p>
          <p className="text-caption text-gray terminal-text">Verify Bitcoin deposit with block header</p>
        </div>
      </div>

      {/* Input Section */}
      <div className="space-y-4 mb-4">
        {/* Taproot Address Input */}
        <div>
          <label className="text-body2 text-gray-light pl-2 mb-2 block">
            Taproot Address
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={taprootAddress}
              onChange={(e) => setTaprootAddress(e.target.value)}
              placeholder="tb1p..."
              className={cn(
                "flex-1 p-3 bg-muted border border-gray/15 rounded-[12px]",
                "text-body2 font-mono text-foreground placeholder:text-gray",
                "outline-none focus:border-privacy/40 transition-colors"
              )}
            />
            <button
              onClick={handleLookupAddress}
              disabled={loading || !taprootAddress.trim()}
              className="btn-tertiary px-4"
            >
              {loading ? <Spinner /> : <Search className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* OR divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-gray/15" />
          <span className="text-caption text-gray">OR</span>
          <div className="flex-1 h-px bg-gray/15" />
        </div>

        {/* Transaction ID Input */}
        <div>
          <label className="text-body2 text-gray-light pl-2 mb-2 block">
            Transaction ID
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={txid}
              onChange={(e) => setTxid(e.target.value)}
              placeholder="64-character hex txid"
              className={cn(
                "flex-1 p-3 bg-muted border border-gray/15 rounded-[12px]",
                "text-body2 font-mono text-foreground placeholder:text-gray",
                "outline-none focus:border-privacy/40 transition-colors"
              )}
            />
            <button
              onClick={handleLookupTxid}
              disabled={loading || !txid.trim()}
              className="btn-tertiary px-4"
            >
              {loading ? <Spinner /> : <Search className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="warning-box mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Verification Data Display */}
      {verificationData && (
        <div className="space-y-4">
          {/* Transaction Info */}
          <div className="gradient-bg-card p-4 rounded-[12px] border border-success/20">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-success" />
              <span className="text-body2-semibold text-success">Transaction Found</span>
            </div>
            <div className="space-y-2 text-caption">
              <div className="flex justify-between">
                <span className="text-gray">TXID</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-gray-light">
                    {txid.slice(0, 8)}...{txid.slice(-8)}
                  </span>
                  <button
                    onClick={() => copyToClipboard(txid, "txid")}
                    className="p-1 hover:bg-gray/10 rounded"
                  >
                    {copied === "txid" ? (
                      <Check className="w-3 h-3 text-success" />
                    ) : (
                      <Copy className="w-3 h-3 text-gray" />
                    )}
                  </button>
                </div>
              </div>
              <div className="flex justify-between">
                <span className="text-gray">Confirmations</span>
                <span className="font-mono text-privacy">{verificationData.confirmations}</span>
              </div>
            </div>
          </div>

          {/* Block Header */}
          <div className="gradient-bg-card p-4 rounded-[12px]">
            <div className="flex items-center justify-between mb-3">
              <span className="text-body2-semibold text-btc">Block Header</span>
              <button
                onClick={() => copyToClipboard(verificationData.blockHeader.rawHeader, "header")}
                className="p-1.5 rounded-[6px] bg-btc/10 hover:bg-btc/20 transition-colors"
              >
                {copied === "header" ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-btc" />
                )}
              </button>
            </div>
            <div className="space-y-2 text-caption">
              <div className="flex justify-between">
                <span className="text-gray">Height</span>
                <span className="font-mono text-gray-light">
                  {verificationData.blockHeader.height.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray">Hash</span>
                <span className="font-mono text-gray-light">
                  {verificationData.blockHeader.hash.slice(0, 12)}...
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray">Timestamp</span>
                <span className="font-mono text-gray-light">
                  {new Date(verificationData.blockHeader.timestamp * 1000).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray">Merkle Root</span>
                <span className="font-mono text-gray-light">
                  {verificationData.blockHeader.merkleRoot.slice(0, 12)}...
                </span>
              </div>
            </div>
            {/* Raw header */}
            <div className="mt-3 p-2 bg-background rounded-[8px]">
              <p className="text-caption text-gray mb-1">Raw Header (80 bytes)</p>
              <code className="text-[10px] font-mono text-gray-light break-all block">
                {verificationData.blockHeader.rawHeader}
              </code>
            </div>

            {/* Submit Block Header Button */}
            <div className="mt-3">
              {headerSubmitted ? (
                <div className="flex items-center gap-2 p-2 bg-success/10 border border-success/20 rounded-[8px]">
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  <span className="text-caption text-success">Header on Solana</span>
                  {headerTxSig && (
                    <a
                      href={`https://orbmarkets.io/tx/${headerTxSig}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] font-mono text-privacy ml-auto hover:underline"
                    >
                      {headerTxSig.slice(0, 12)}...
                    </a>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleSubmitBlockHeader}
                  disabled={headerSubmitting}
                  className="btn-bitcoin w-full text-sm py-2"
                >
                  {headerSubmitting ? (
                    <span className="flex items-center gap-2">
                      <Spinner />
                      Submitting via Relayer...
                    </span>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      Submit Header to Solana
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Merkle Proof */}
          <div className="gradient-bg-card p-4 rounded-[12px]">
            <div className="flex items-center justify-between mb-3">
              <span className="text-body2-semibold text-privacy">Merkle Proof</span>
              <button
                onClick={() => copyToClipboard(
                  JSON.stringify(verificationData.merkleProof.merkleProof, null, 2),
                  "merkle"
                )}
                className="p-1.5 rounded-[6px] bg-privacy/10 hover:bg-privacy/20 transition-colors"
              >
                {copied === "merkle" ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-privacy" />
                )}
              </button>
            </div>
            <div className="space-y-2 text-caption">
              <div className="flex justify-between">
                <span className="text-gray">TX Index</span>
                <span className="font-mono text-gray-light">{verificationData.merkleProof.txIndex}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray">Proof Length</span>
                <span className="font-mono text-gray-light">
                  {verificationData.merkleProof.merkleProof.length} siblings
                </span>
              </div>
            </div>
            {/* Merkle siblings */}
            <div className="mt-3 p-2 bg-background rounded-[8px] max-h-32 overflow-y-auto">
              <p className="text-caption text-gray mb-1">Siblings (SHA256)</p>
              {verificationData.merkleProof.merkleProof.map((hash, i) => (
                <code key={i} className="text-[10px] font-mono text-gray-light block">
                  [{i}] {hash}
                </code>
              ))}
            </div>
          </div>

          {/* View on Explorer */}
          <div className="flex gap-2">
            <a
              href={`https://mempool.space/testnet/tx/${txid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-tertiary flex-1 justify-center"
            >
              View TX <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href={`https://mempool.space/testnet/block/${verificationData.blockHeader.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-tertiary flex-1 justify-center"
            >
              View Block <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Submit to Solana */}
          {connected ? (
            <button className="btn-primary w-full" disabled>
              <Shield className="w-5 h-5" />
              Submit to Solana (Coming Soon)
            </button>
          ) : (
            <WalletButton className="btn-primary w-full justify-center" />
          )}
        </div>
      )}

      {/* Empty state */}
      {!verificationData && !loading && !error && (
        <div className="text-center py-8 text-gray">
          <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-body2">Enter an address or txid to fetch verification data</p>
        </div>
      )}
    </div>
  );
}
