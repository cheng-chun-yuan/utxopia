import {
  ExternalLink,
  Wallet,
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { getSolanaExplorerAddressUrl } from "@/lib/solana-network";
import { truncate } from "../helpers";
import { SUPPORTED_TOKENS, getTokenBySymbol } from "@/lib/supported-tokens";
import { resolveTokenSymbolSync } from "@/lib/token-map";
import {
  type TransferTx,
  getTxUnshieldOutputs,
  getTxCommitmentOutputs,
  NullifierInputsList,
  CommitmentRow,
  UnshieldAmountDisplay,
} from "./detail-helpers";

export function UnshieldDetails({ tx }: { tx: TransferTx }) {
  const tokenSym = tx.tokenSymbol ?? (tx.tokenId ? resolveTokenSymbolSync(tx.tokenId) : null);
  const token = tokenSym ? getTokenBySymbol(tokenSym) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  const unshieldOutputs = getTxUnshieldOutputs(tx);
  const commitmentOutputs = getTxCommitmentOutputs(tx);
  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT — nullifiers only */}
        <NullifierInputsList tx={tx} />

        {/* OUTPUTS — each rendered separately */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">
              Output{tx.outputs.length !== 1 ? "s" : ""}
            </span>
            <span className="text-caption text-purple-400/60 font-medium">{tx.outputs.length}</span>
          </div>
          {/* Unshield/withdraw outputs — each separate */}
          {unshieldOutputs.map((out, i) => (
            <div key={out.recipient ?? i} className="px-3 py-2.5 rounded-[8px] bg-purple-500/4 border border-purple-500/10 space-y-2">
              {out.amount ? (
                <UnshieldAmountDisplay
                  grossAmount={out.amount}
                  netAmount={out.payout ?? out.amount}
                  fee={out.fee ?? 0}
                  token={token}
                />
              ) : (
                <span className="text-caption text-gray/40">Amount pending re-index</span>
              )}
              {out.recipient ? (
                <div className="group flex items-center gap-2">
                  <Wallet className="w-3.5 h-3.5 text-sol/50 shrink-0" />
                  <code className="text-caption font-mono text-foreground/80 truncate">{truncate(out.recipient, 8, 6)}</code>
                  <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                    <CopyButton text={out.recipient} label="Address" variant="default" iconSize="sm" />
                    <a
                      href={getSolanaExplorerAddressUrl(out.recipient)}
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
          ))}
          {/* Commitment change outputs */}
          {commitmentOutputs.map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment!} leafIndex={out.leafIndex!} txSignature={tx.txSignature} index={unshieldOutputs.length + i + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
