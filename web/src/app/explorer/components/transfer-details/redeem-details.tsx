import {
  ExternalLink,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import type { RedemptionRecord } from "@/hooks/use-explorer";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { useChainEnvironment } from "@/lib/chain-environment";
import { getChainAdapter } from "@/lib/chain-registry";
import { getChainIcon, getChainMutedLinkClass, getChainTransactionUrl } from "@/lib/chain-links";
import { truncate } from "../helpers";
import { SUPPORTED_TOKENS, formatTokenAmount, getTokenBySymbol } from "@/lib/supported-tokens";
import { resolveTokenSymbolSync } from "@/lib/token-map";
import {
  type TransferTx,
  getTxInputCount,
  getTxNullifierPdas,
  getTxUnshieldAmount,
  getTxUnshieldRecipient,
  getTxCommitmentOutputs,
  NullifierRow,
  CommitmentRow,
} from "./detail-helpers";

export function RedeemDetails({ tx, redemption }: { tx: TransferTx; redemption?: RedemptionRecord }) {
  const tokenSym = tx.tokenSymbol ?? (tx.tokenId ? resolveTokenSymbolSync(tx.tokenId) : null);
  const token = tokenSym ? getTokenBySymbol(tokenSym) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  const r = redemption;
  const grossAmount = r ? Number(r.amountSats) : getTxUnshieldAmount(tx);
  const netReceived = r?.actualReceived ? Number(r.actualReceived) : getTxUnshieldAmount(tx);
  const serviceFee = r?.serviceFee ? Number(r.serviceFee) : 0;

  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT — Shielded note burned */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Input</span>
            <span className="text-caption text-green-400/60 font-medium">{getTxInputCount(tx)}</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-green-500/4 border border-green-500/10 space-y-1.5">
            <div className="flex items-center gap-2">
              <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {grossAmount ? formatTokenAmount(grossAmount, token) : "\u2014"}
              </span>
            </div>
            <span className="text-[10px] text-gray/50">Shielded note (burned)</span>
          </div>
          {/* Nullifier */}
          {getTxNullifierPdas(tx).length > 0 && getTxNullifierPdas(tx).map((pda, i) => (
            <NullifierRow key={pda} pda={pda} index={i} />
          ))}
        </div>

        {/* OUTPUT — BTC sent */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-btc" />
            <span className="text-caption text-btc/90 font-semibold uppercase tracking-wider">Output</span>
            <span className="text-caption text-btc/60 font-medium">1</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-btc/4 border border-btc/10 space-y-2">
            <div className="flex items-center gap-2">
              <BitcoinIcon className="w-3.5 h-3.5 text-btc shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {netReceived ? formatTokenAmount(netReceived, token) : "\u2014"}
              </span>
            </div>
            {(getTxUnshieldRecipient(tx) ?? "") ? (
              <div className="group flex items-center gap-2">
                <span className="text-[10px] text-gray/50 shrink-0">&rarr;</span>
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate((getTxUnshieldRecipient(tx) ?? ""), 10, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={(getTxUnshieldRecipient(tx) ?? "")} label="BTC Address" variant="default" iconSize="sm" />
                  <a href={`${getMempoolExplorerUrl()}/address/${(getTxUnshieldRecipient(tx) ?? "")}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <BitcoinIcon className="w-3.5 h-3.5 text-gray/30 shrink-0" />
                <span className="text-caption text-gray/40">Recipient pending</span>
              </div>
            )}
          </div>
          {/* Change outputs */}
          {getTxCommitmentOutputs(tx).map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment!} leafIndex={out.leafIndex!} txSignature={tx.txSignature} index={i + 2} />
          ))}
        </div>
      </div>

      {/* Vertical timeline + service fee */}
      <div className="px-5 pb-4 pt-2 border-t border-gray/10 space-y-2">
        {serviceFee > 0 && (
          <span className="text-[10px] text-gray/60 font-mono">
            Service fee: {formatTokenAmount(serviceFee, token)}
          </span>
        )}
        <WithdrawTimeline tx={tx} redemption={r} />
      </div>
    </div>
  );
}

/** Vertical timeline showing withdrawal lifecycle */
function WithdrawTimeline({ tx, redemption: r }: { tx: TransferTx; redemption?: RedemptionRecord }) {
  const { config } = useChainEnvironment();
  const chain = getChainAdapter(config);
  const chainName = chain.displayName;
  const chainIcon = getChainIcon(config);
  const chainTxUrl = (id: string) => getChainTransactionUrl(config, id);
  const statusOrder: Record<string, number> = { Pending: 1, Processing: 2, "BTC Sent": 3, Completed: 4 };
  const completedFromTx = tx.status === "confirmed" && tx.outputs.some((output) => output.type === "withdraw" && output.btcTxid);
  const current = completedFromTx ? 4 : (statusOrder[r?.status ?? "Pending"] ?? (tx.status === "confirmed" ? 2 : 1));

  const steps = [
    {
      title: "Request Redemption",
      done: current >= 1,
      icon: "sol" as const,
      txId: tx.txSignature,
    },
    {
      title: "Mark Processing",
      done: current >= 2,
      icon: "sol" as const,
      txId: r?.processingTxSignature ?? null,
    },
    {
      title: "BTC Sent",
      done: current >= 3,
      icon: "btc" as const,
      txId: r?.btcTxid ?? null,
    },
    {
      title: "Complete Redemption",
      done: current >= 4,
      icon: "sol" as const,
      txId: r?.completeTxSignature ?? (completedFromTx ? tx.txSignature : null),
    },
  ];

  return (
    <div className="space-y-0">
      {steps.map((step, i) => (
        <div key={step.title} className="flex gap-3">
          <div className="flex flex-col items-center w-5">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center shrink-0 border",
              step.done ? "bg-green-500/15 border-green-500/30" : "bg-gray/8 border-gray/15"
            )}>
              {step.done ? (
                <CheckCircle2 className="w-3 h-3 text-green-400" />
              ) : (
                <Loader2 className="w-3 h-3 text-gray/40 animate-spin" />
              )}
            </div>
            {i < steps.length - 1 && (
              <div className={cn("w-px flex-1 min-h-[20px]", step.done ? "bg-green-500/20" : "bg-gray/10")} />
            )}
          </div>
          <div className="flex-1 pb-3">
            <div className="flex items-center gap-2">
              {step.icon === "btc" ? (
                <BitcoinIcon className="w-3.5 h-3.5 text-btc/70" />
              ) : (
                <img src={chainIcon} alt={chainName} className="w-3.5 h-3.5 rounded-full opacity-70" />
              )}
              <span className={cn("text-[12px] font-medium", step.done ? "text-foreground" : "text-gray/50")}>
                {step.title}
              </span>
            </div>
            {step.txId && step.done && (
              <div className="group flex items-center gap-1.5 mt-1">
                <span className="text-[10px] text-gray/40">{step.icon === "btc" ? "Transaction ID" : `${chainName} tx`}</span>
                <code className="text-[10px] font-mono text-gray/60 truncate max-w-[280px]">{step.txId}</code>
                <CopyButton text={step.txId} label={step.title} variant="default" iconSize="sm" />
                <a
                  href={step.icon === "btc" ? `${getMempoolExplorerUrl()}/tx/${step.txId}` : chainTxUrl(step.txId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn("transition-colors p-0.5", step.icon === "btc" ? "text-btc/40 hover:text-btc" : getChainMutedLinkClass(config))}
                >
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
