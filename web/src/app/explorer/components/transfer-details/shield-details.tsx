import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { ExternalLink } from "lucide-react";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { truncate } from "../helpers";
import { SUPPORTED_TOKENS, formatTokenAmount, getTokenBySymbol } from "@/lib/supported-tokens";
import { resolveTokenSymbolSync } from "@/lib/token-map";
import { CommitmentRow, type TransferTx } from "./detail-helpers";

export function ShieldDetails({ tx }: { tx: TransferTx }) {
  const tokenSym = tx.tokenSymbol ?? (tx.tokenId ? resolveTokenSymbolSync(tx.tokenId) : null);
  const token = tokenSym ? getTokenBySymbol(tokenSym) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  const isBtc = token.isBtcNative || token.symbol === "BTC" || token.symbol === "zkBTC";
  const isPending = !tx.txSignature || (tx.outputs?.[0]?.leafIndex ?? -1) < 0;
  const grossAmount = tx.inputs?.[0]?.grossAmount ?? tx.inputs?.[0]?.netAmount ?? tx.outputs?.[0]?.amount ?? 0;
  const netAmount = tx.inputs?.[0]?.netAmount ?? tx.outputs?.[0]?.amount ?? grossAmount;
  const fee = tx.inputs?.[0]?.fee ?? 0;
  const hasFee = fee > 0 && grossAmount !== netAmount;
  const btcMeta = tx.btcMeta;

  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Input</span>
          </div>
          <div className={cn("px-3 py-2.5 rounded-[8px] space-y-1.5", isBtc ? "bg-btc/4 border border-btc/10" : "bg-green-500/4 border border-green-500/10")}>
            <div className="flex items-center gap-2">
              <img src={token.logo} alt={token.symbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {grossAmount ? formatTokenAmount(grossAmount, token) : "\u2014"}
              </span>
            </div>
            {hasFee && (
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="text-gray/50">Fee: {formatTokenAmount(fee, token)}</span>
                <span className="text-gray/30">&rarr;</span>
                <span className="text-green-400/80 font-mono font-medium">{formatTokenAmount(netAmount, token)} shielded</span>
              </div>
            )}
            {btcMeta?.depositTxid && (
              <div className="group flex items-center gap-2">
                <span className="text-[10px] text-gray/50 shrink-0">BTC Tx</span>
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(btcMeta.depositTxid, 8, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={btcMeta.depositTxid} label="BTC Tx" variant="default" iconSize="sm" />
                  <a href={`${getMempoolExplorerUrl()}/tx/${btcMeta.depositTxid}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            )}
            {btcMeta?.taprootAddress && (
              <div className="group flex items-center gap-2">
                <span className="text-[10px] text-gray/50 shrink-0">&rarr;</span>
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(btcMeta.taprootAddress, 8, 6)}</code>
                <CopyButton text={btcMeta.taprootAddress} label="Address" variant="default" iconSize="sm" />
              </div>
            )}
          </div>
          {btcMeta && (
            <div className="px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 text-caption text-gray/60 space-y-1">
              <div className="flex justify-between">
                <span>Confirmations</span>
                <span className="font-mono">{btcMeta.confirmations == null ? "—" : btcMeta.confirmations}</span>
              </div>
              {btcMeta.sweepTxid && <div className="flex justify-between"><span>Sweep</span><span className="font-mono text-foreground/80">{truncate(btcMeta.sweepTxid, 6, 4)}</span></div>}
              {btcMeta.sweepConfirmations != null && (
                <div className="flex justify-between"><span>Sweep Conf</span><span className="font-mono">{btcMeta.sweepConfirmations}</span></div>
              )}
            </div>
          )}
        </div>

        {/* OUTPUT — Shielded commitment */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">Output</span>
          </div>
          {isPending ? (
            <div className="flex items-center justify-center gap-2 px-3 py-3 rounded-[8px] bg-gray/4 border border-gray/8">
              <Loader2 className="w-3.5 h-3.5 text-gray/40 animate-spin" />
              <span className="text-caption text-gray/50">Waiting for confirmation</span>
            </div>
          ) : (
            <CommitmentRow
              commitment={tx.outputs[0]?.commitment ?? ""}
              leafIndex={tx.outputs[0]?.leafIndex ?? 0}
              txSignature={tx.txSignature}
              index={0}
            />
          )}
        </div>
      </div>
    </div>
  );
}
