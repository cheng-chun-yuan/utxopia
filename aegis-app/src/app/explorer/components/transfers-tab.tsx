"use client";

/**
 * Transfers Tab — displays shielded JoinSplit transactions.
 * Handles three transfer types: Private Send, Unshield (zkBTC → SPL),
 * and Redeem (zkBTC → BTC). Each has its own expandable detail view
 * showing nullifier inputs and commitment/BTC outputs.
 */

import { useState, useCallback, Fragment } from "react";
import Image from "next/image";
import {
  ExternalLink,
  Shield,
  Unlock,
  Wallet,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useTransfers } from "@/hooks/use-explorer";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl, getSolanaExplorerAddressUrl } from "@/lib/solana-network";
import { truncate, timeAgo } from "./helpers";
import { Th, Td, SolanaLink, TypeBadge, StatusDot, FlowCell, LoadingState, ErrorState, EmptyState, RefreshButton } from "./shared";
import { SUPPORTED_TOKENS, formatTokenAmount, getTokenBySymbol, type SupportedToken } from "@/lib/supported-tokens";

// =============================================================================
// Transfer Row — single unified table row + expandable detail
// =============================================================================

export type TransferTxPublic = TransferTx;

/** Determine the unified kind for a transfer row */
export function getTransferKind(tx: TransferTx): "transfer" | "unshield" {
  if (isRedeemType(tx) || tx.instructionDisc === 15) return "unshield";
  return "transfer";
}

export function TransferRow({
  tx,
  expanded,
  onToggle,
}: {
  tx: TransferTx;
  expanded: boolean;
  onToggle: () => void;
}) {
  const kind = getTransferKind(tx);
  const isUnshield = kind === "unshield";
  const token = tx.tokenSymbol ? getTokenBySymbol(tx.tokenSymbol) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];

  return (
    <Fragment>
      <tr
        className="hover:bg-gray/5 transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <Td>
          <StatusDot
            variant={tx.status === "processing" ? "processing" : "confirmed"}
            label={tx.status === "processing" ? "Processing" : "Confirmed"}
          />
        </Td>
        <Td>
          <div className="flex items-center gap-1.5">
            <code className="text-caption font-mono text-foreground">{truncate(tx.txSignature, 6, 4)}</code>
            <CopyButton text={tx.txSignature} label="Tx" variant="default" iconSize="sm" />
          </div>
        </Td>
        <Td>
          <TypeBadge kind={kind} />
        </Td>
        <Td>
          {isUnshield ? (
            <FlowCell
              from={{ icon: "shield", label: "Shielded" }}
              to={{ icon: isRedeemType(tx) ? "/tokens/btc.png" : token.logo, label: isRedeemType(tx) ? "BTC" : token.symbol }}
              meta={`${tx.inputCount} in, ${isUnshield ? tx.outputs.length + 1 : tx.outputs.length} out`}
            />
          ) : (
            <FlowCell
              from={{ icon: "shield", label: "Shielded" }}
              to={{ icon: "shield", label: "Shielded" }}
              meta={`${tx.inputCount} in, ${tx.outputs.length} out`}
            />
          )}
        </Td>
        <Td>
          {isUnshield && tx.unshieldAmount ? (
            <span className="text-body2 text-foreground font-mono">
              {token.showRawAmount
                ? tx.unshieldAmount.toLocaleString()
                : (tx.unshieldAmount / (10 ** token.decimals)).toLocaleString(undefined, { maximumFractionDigits: token.decimals })
              } <span className="text-gray text-caption">{token.unit}</span>
            </span>
          ) : isUnshield ? (
            <span className="text-caption text-gray/40">&mdash;</span>
          ) : (
            <span className="text-caption text-gray/40">&mdash; (private)</span>
          )}
        </Td>
        <Td>
          <span className="text-caption text-gray">{timeAgo(tx.timestamp)}</span>
        </Td>
        <Td>
          <SolanaLink signature={tx.txSignature} />
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <TransferDetails tx={tx} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// =============================================================================
// Transfers Tab (standalone, kept for backward compat)
// =============================================================================

export function TransfersTab() {
  const { transfers, isLoading, error, refresh } = useTransfers();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((sig: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sig)) next.delete(sig);
      else next.add(sig);
      return next;
    });
  }, []);

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (transfers.length === 0) return <EmptyState label="transfers" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{transfers.length} transaction(s)</span>
        <RefreshButton onClick={refresh} />
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-gray/15 backdrop-blur-sm bg-muted/30">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-gray/15 bg-muted/50">
              <Th>Status</Th>
              <Th>Tx ID</Th>
              <Th>Type</Th>
              <Th>Flow</Th>
              <Th>Amount</Th>
              <Th>Time</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {transfers.map((tx) => (
              <TransferRow
                key={tx.txSignature}
                tx={tx}
                expanded={expanded.has(tx.txSignature)}
                onToggle={() => toggle(tx.txSignature)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

type TransferTx = ReturnType<typeof useTransfers>["transfers"][number];

/**
 * Check if a transfer is a BTC redeem operation.
 * TODO(backward-compat): disc=5 is the legacy request_redemption instruction;
 * disc=16 is the current redeem. Remove disc=5 check once old txs are no longer indexed.
 */
function isRedeemType(tx: TransferTx) {
  return tx.instructionDisc === 16 || tx.instructionDisc === 5 || (tx.operationType === 0 && tx.instructionDisc !== 15);
}

function TransferTypeBadge({ tx }: { tx: TransferTx }) {
  if (isRedeemType(tx)) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="p-1 rounded-[6px] bg-btc/10 border border-btc/20">
          <BitcoinIcon className="w-3 h-3 text-btc" />
        </div>
        <div className="flex flex-col">
          <span className="text-caption text-btc font-semibold leading-tight">Redeem</span>
          <span className="text-[10px] text-gray leading-tight">zkBTC → BTC</span>
        </div>
      </div>
    );
  }
  if (tx.instructionDisc === 15) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="p-1 rounded-[6px] bg-purple-500/10 border border-purple-500/20">
          <Unlock className="w-3 h-3 text-purple-400" />
        </div>
        <div className="flex flex-col">
          <span className="text-caption text-purple-400 font-semibold leading-tight">Unshield</span>
          <span className="text-[10px] text-gray leading-tight">zkBTC → SPL</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className="p-1 rounded-[6px] bg-privacy/10 border border-privacy/20">
        <Shield className="w-3 h-3 text-privacy" />
      </div>
      <div className="flex flex-col">
        <span className="text-caption text-privacy font-semibold leading-tight">Private Send</span>
        <span className="text-[10px] text-gray leading-tight">Shielded transfer</span>
      </div>
    </div>
  );
}

function TransferAssetBadge({ tx }: { tx: TransferTx }) {
  const token = tx.tokenSymbol ? getTokenBySymbol(tx.tokenSymbol) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  // Redeem = zkBTC → BTC, everything else = shielded token
  if (isRedeemType(tx)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-btc/90 bg-btc/6 border border-btc/15 px-2 py-0.5 rounded-full font-medium">
        <img src={token.logo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full" />
        {token.shieldedSymbol}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-privacy/90 bg-privacy/6 border border-privacy/15 px-2 py-0.5 rounded-full font-medium">
      <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full" />
      {token.shieldedSymbol}
    </span>
  );
}

function TransferOutputCount({ tx }: { tx: TransferTx }) {
  if (tx.instructionDisc === 15 || isRedeemType(tx)) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-purple-400/70 bg-purple-500/6 border border-purple-500/12 px-2 py-0.5 rounded-full">
        <span className="font-mono">{1 + tx.outputs.length}</span>
        <span className="hidden sm:inline">output{tx.outputs.length > 0 ? "s" : ""}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-caption text-purple-400/70 bg-purple-500/6 border border-purple-500/12 px-2 py-0.5 rounded-full">
      <span className="font-mono">{tx.outputs.length}</span>
      <span className="hidden sm:inline">output{tx.outputs.length !== 1 ? "s" : ""}</span>
    </span>
  );
}

// --- Shared detail sub-components ---

function NullifierInputsList({ tx }: { tx: TransferTx }) {
  return (
    <div className="p-4 space-y-2.5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
        <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Inputs</span>
        <span className="text-caption text-green-400/60 font-medium">{tx.inputCount}</span>
      </div>
      {tx.nullifierPdas.length > 0 ? tx.nullifierPdas.map((pda, i) => (
        <NullifierRow key={pda} pda={pda} index={i} />
      )) : (
        <div className="flex items-center justify-center gap-2 px-3 py-3 rounded-[8px] bg-gray/4 border border-gray/8">
          <Shield className="w-3.5 h-3.5 text-gray/30" />
          <span className="text-caption text-gray/40">No nullifiers (deposit claim)</span>
        </div>
      )}
    </div>
  );
}

function NullifierRow({ pda, index }: { pda: string; index: number }) {
  return (
    <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-green-500/4 border border-green-500/10 hover:border-green-500/20 transition-colors">
      <span className="text-[10px] text-green-400/60 font-mono font-semibold w-4 shrink-0">{index + 1}</span>
      <code className="text-caption font-mono text-foreground/90 truncate">{truncate(pda, 8, 6)}</code>
      <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <CopyButton text={pda} label="Nullifier" variant="default" iconSize="sm" />
        <a
          href={getSolanaExplorerAddressUrl(pda)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol hover:text-sol/80 transition-colors p-0.5"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

function CommitmentRow({ commitment, leafIndex, txSignature, index }: { commitment: string; leafIndex: number; txSignature: string; index: number }) {
  return (
    <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-purple-500/4 border border-purple-500/10 hover:border-purple-500/20 transition-colors">
      <span className="text-[10px] text-purple-400/60 font-mono font-semibold w-4 shrink-0">{index}</span>
      <code className="text-caption font-mono text-foreground/90 truncate">{truncate(commitment, 8, 6)}</code>
      <span className="text-[10px] text-gray/50 font-mono bg-gray/8 px-1.5 py-0.5 rounded shrink-0">#{leafIndex}</span>
      <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <CopyButton text={commitment} label="Commitment" variant="default" iconSize="sm" />
        <a
          href={getSolanaExplorerTxUrl(txSignature)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol hover:text-sol/80 transition-colors p-0.5"
          title="View transaction"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

// --- Transfer Details ---

function TransferDetails({ tx }: { tx: TransferTx }) {
  if (isRedeemType(tx)) return <RedeemDetails tx={tx} />;
  if (tx.instructionDisc === 15) return <UnshieldDetails tx={tx} />;
  return <StandardTransferDetails tx={tx} />;
}

function RedeemDetails({ tx }: { tx: TransferTx }) {
  const token = tx.tokenSymbol ? getTokenBySymbol(tx.tokenSymbol) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        <NullifierInputsList tx={tx} />
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-btc" />
            <span className="text-caption text-btc/90 font-semibold uppercase tracking-wider">Outputs</span>
            <span className="text-caption text-btc/60 font-medium">{1 + tx.outputs.length}</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-btc/4 border border-btc/10 space-y-2">
            <div className="flex items-center gap-2">
              <BitcoinIcon className="w-3.5 h-3.5 text-btc shrink-0" />
              {tx.unshieldAmount ? (
                <span className="text-body2 text-foreground font-mono font-semibold">
                  {formatTokenAmount(tx.unshieldAmount, token)}
                </span>
              ) : (
                <span className="text-caption text-gray/40">Amount pending re-index</span>
              )}
            </div>
            {tx.unshieldRecipient ? (
              <div className="group flex items-center gap-2">
                <BitcoinIcon className="w-3.5 h-3.5 text-btc/50 shrink-0" />
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(tx.unshieldRecipient, 10, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={tx.unshieldRecipient} label="BTC Address" variant="default" iconSize="sm" />
                  <a
                    href={`${getMempoolExplorerUrl()}/address/${tx.unshieldRecipient}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-btc hover:text-btc/80 transition-colors p-0.5"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <BitcoinIcon className="w-3.5 h-3.5 text-gray/30 shrink-0" />
                <span className="text-caption text-gray/40">BTC address pending re-index</span>
              </div>
            )}
          </div>
          {tx.outputs.map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment} leafIndex={out.leafIndex} txSignature={tx.txSignature} index={i + 2} />
          ))}
        </div>
      </div>
    </div>
  );
}

function UnshieldDetails({ tx }: { tx: TransferTx }) {
  const token = tx.tokenSymbol ? getTokenBySymbol(tx.tokenSymbol) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        <NullifierInputsList tx={tx} />
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">Outputs</span>
            <span className="text-caption text-purple-400/60 font-medium">{1 + tx.outputs.length}</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-purple-500/4 border border-purple-500/10 space-y-2">
            <div className="flex items-center gap-2">
              <img src={token.logo} alt={token.symbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
              {tx.unshieldAmount ? (
                <span className="text-body2 text-foreground font-mono font-semibold">
                  {formatTokenAmount(tx.unshieldAmount, token)}
                </span>
              ) : (
                <span className="text-caption text-gray/40">Amount pending re-index</span>
              )}
            </div>
            {tx.unshieldRecipient ? (
              <div className="group flex items-center gap-2">
                <Wallet className="w-3.5 h-3.5 text-sol/50 shrink-0" />
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(tx.unshieldRecipient, 8, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={tx.unshieldRecipient} label="Address" variant="default" iconSize="sm" />
                  <a
                    href={getSolanaExplorerAddressUrl(tx.unshieldRecipient)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sol hover:text-sol/80 transition-colors p-0.5"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Wallet className="w-3.5 h-3.5 text-gray/30 shrink-0" />
                <span className="text-caption text-gray/40">Recipient pending re-index</span>
              </div>
            )}
          </div>
          {tx.outputs.map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment} leafIndex={out.leafIndex} txSignature={tx.txSignature} index={i + 2} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StandardTransferDetails({ tx }: { tx: TransferTx }) {
  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        <NullifierInputsList tx={tx} />
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">Outputs</span>
            <span className="text-caption text-purple-400/60 font-medium">{tx.outputs.length}</span>
          </div>
          {tx.outputs.map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment} leafIndex={out.leafIndex} txSignature={tx.txSignature} index={i + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
