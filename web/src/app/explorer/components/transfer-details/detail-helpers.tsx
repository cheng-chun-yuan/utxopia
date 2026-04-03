/**
 * Shared helper functions and sub-components used by detail views.
 */

import {
  ExternalLink,
  Shield,
  Wallet,
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { getSolanaExplorerTxUrl, getSolanaExplorerAddressUrl } from "@/lib/solana-network";
import { truncate } from "../helpers";
import type { ExplorerTransaction } from "@/hooks/use-explorer";
import type { SupportedToken } from "@/lib/supported-tokens";

export type TransferTx = ExplorerTransaction;

// Helper accessors — extract old flat fields from new typed outputs
export function getTxUnshieldOutputs(tx: TransferTx) {
  return tx.outputs.filter((o) => o.type === "unshield" || o.type === "withdraw");
}
export function getTxCommitmentOutputs(tx: TransferTx) {
  return tx.outputs.filter((o) => o.type === "commitment");
}
export function getTxUnshieldAmount(tx: TransferTx): number | undefined {
  const outs = getTxUnshieldOutputs(tx);
  if (outs.length === 0) return undefined;
  return outs.reduce((sum, o) => sum + (o.amount ?? 0), 0);
}
export function getTxUnshieldFee(tx: TransferTx): number | undefined {
  const outs = getTxUnshieldOutputs(tx);
  if (outs.length === 0) return undefined;
  return outs.reduce((sum, o) => sum + (o.fee ?? 0), 0);
}
export function getTxUnshieldPayout(tx: TransferTx): number | undefined {
  const outs = getTxUnshieldOutputs(tx);
  if (outs.length === 0) return undefined;
  return outs.reduce((sum, o) => sum + (o.payout ?? 0), 0);
}
export function getTxUnshieldRecipient(tx: TransferTx): string | undefined {
  return getTxUnshieldOutputs(tx)[0]?.recipient;
}
export function getTxInputCount(tx: TransferTx): number {
  return tx.inputs.length;
}
export function getTxNullifierPdas(tx: TransferTx): string[] {
  return tx.inputs.map((i) => i.nullifierPda).filter(Boolean) as string[];
}

// --- Shared detail sub-components ---

export function NullifierInputsList({ tx }: { tx: TransferTx }) {
  return (
    <div className="p-4 space-y-2.5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
        <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Inputs</span>
        <span className="text-caption text-green-400/60 font-medium">{getTxInputCount(tx)}</span>
      </div>
      {getTxNullifierPdas(tx).length > 0 ? getTxNullifierPdas(tx).map((pda, i) => (
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

export function NullifierRow({ pda, index }: { pda: string; index: number }) {
  return (
    <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 hover:border-gray/15 transition-colors">
      <span className="text-[10px] text-gray/50 shrink-0">Nullifier</span>
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

export function CommitmentRow({ commitment, leafIndex, txSignature, index }: { commitment: string; leafIndex: number; txSignature: string; index: number }) {
  return (
    <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 hover:border-gray/15 transition-colors">
      <span className="text-[10px] text-gray/50 shrink-0">Commitment</span>
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

export function UnshieldAmountDisplay({ grossAmount, netAmount, fee, token }: { grossAmount: number; netAmount: number; fee: number; token: SupportedToken }) {
  const fmt = (v: number) => token.showRawAmount
    ? v.toLocaleString()
    : (v / (10 ** token.decimals)).toLocaleString(undefined, { maximumFractionDigits: token.decimals });
  // Unshield output is the SPL token: zkBTC for BTC, USDC for USDC, etc.
  const outSymbol = token.isBtcNative ? token.shieldedSymbol : token.symbol;
  const outLogo = token.isBtcNative ? token.shieldedLogo : token.logo;
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
        <span className="text-body2 text-foreground font-mono font-semibold">
          {fmt(grossAmount)} <span className="text-[10px] text-gray font-normal">{token.shieldedSymbol}</span>
        </span>
        <span className="text-[10px] text-gray/40">&rarr;</span>
        <img src={outLogo} alt={outSymbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
        <span className="text-body2 text-foreground font-mono font-semibold">
          {fmt(netAmount)} <span className="text-[10px] text-gray font-normal">{outSymbol}</span>
        </span>
      </div>
      {fee > 0 && (
        <div className="text-[10px] text-gray/50 font-mono pt-1 border-t border-purple-500/8">
          Service fee {fmt(fee)} {token.unit}
        </div>
      )}
    </>
  );
}
