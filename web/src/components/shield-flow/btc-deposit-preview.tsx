"use client";

import { AlertCircle, ArrowRight, ChevronDown, Loader2, Shield, Wallet } from "lucide-react";
import type { BtcDepositState } from "@/hooks/use-btc-deposit";
import { cn } from "@/lib/utils";

interface BtcDepositPreviewProps {
  className?: string;
  btcDeposit: BtcDepositState;
  status: "idle" | "processing" | "done" | "error";
  error: string | null;
}

export function BtcDepositPreview({
  className,
  btcDeposit,
  status,
  error,
}: BtcDepositPreviewProps) {
  const depositPreview = btcDeposit.depositPreview;
  if (!depositPreview) return null;

  const totalInput = depositPreview.cachedUtxos
    .filter((u) => btcDeposit.selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
    .reduce((sum, u) => sum + u.value, 0);
  const estimatedVsize = btcDeposit.selectedUtxoKeys.size * 68 + 78 + 43 + 43 + 12;
  const estimatedFee = estimatedVsize * 2;
  const changeAmount = totalInput - depositPreview.depositAmountSats - estimatedFee;
  const insufficientFunds = totalInput < depositPreview.depositAmountSats + estimatedFee;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
        <div className="flex items-center justify-between">
          <p className="text-caption text-gray">
            Inputs ({btcDeposit.selectedUtxoKeys.size} UTXO{btcDeposit.selectedUtxoKeys.size !== 1 ? "s" : ""})
            <span className="text-foreground ml-1">{(totalInput / 1e8).toFixed(8)} BTC</span>
          </p>
          <div className="flex items-center gap-2">
            {btcDeposit.showUtxoList && (
              <button onClick={() => btcDeposit.setEditingUtxos(!btcDeposit.editingUtxos)} className={cn("text-[10px] transition-colors cursor-pointer", btcDeposit.editingUtxos ? "text-warning hover:text-warning/80" : "text-sol hover:text-sol-light")}>
                {btcDeposit.editingUtxos ? "Done" : "Edit"}
              </button>
            )}
            <button onClick={() => { btcDeposit.setShowUtxoList(!btcDeposit.showUtxoList); if (btcDeposit.showUtxoList) btcDeposit.setEditingUtxos(false); }} className="text-[10px] text-gray hover:text-gray-light transition-colors cursor-pointer">
              {btcDeposit.showUtxoList ? "Hide" : "Show UTXOs"}
            </button>
          </div>
        </div>
        {btcDeposit.showUtxoList && (
          <div className="space-y-1.5 max-h-36 overflow-y-auto mt-2">
            {depositPreview.cachedUtxos.map((utxo) => {
              const key = `${utxo.txid}:${utxo.vout}`;
              const isSelected = btcDeposit.selectedUtxoKeys.has(key);
              if (!btcDeposit.editingUtxos && !isSelected) return null;
              return (
                <div key={key} className={cn("flex items-center gap-2 p-2 rounded-[8px] transition-colors", btcDeposit.editingUtxos ? "cursor-pointer" : "", isSelected ? "bg-btc/10 border border-btc/20" : "bg-background border border-gray/10 hover:border-gray/25")}
                  onClick={btcDeposit.editingUtxos ? () => btcDeposit.setSelectedUtxoKeys((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; }) : undefined}>
                  {btcDeposit.editingUtxos && <input type="checkbox" checked={isSelected} readOnly className="accent-btc w-3.5 h-3.5 pointer-events-none" />}
                  <div className="flex-1 min-w-0"><code className="text-[10px] font-mono text-gray-light block truncate">{utxo.txid.slice(0, 8)}...:{utxo.vout}</code></div>
                  <span className="text-[11px] font-mono text-btc whitespace-nowrap">{(utxo.value / 1e8).toFixed(8)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-1">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
        <span className="text-[10px] text-gray/50 uppercase tracking-widest">Outputs</span>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
      </div>

      <div className="p-3 bg-btc/5 border border-btc/20 rounded-[12px]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-btc/15 flex items-center justify-center"><ArrowRight className="w-3 h-3 text-btc" /></div>
            <span className="text-caption font-semibold text-btc">Deposit</span>
          </div>
          <span className="text-[10px] font-mono bg-btc/10 text-btc/70 px-1.5 py-0.5 rounded">P2TR</span>
        </div>
        <p className="text-body2-semibold font-mono text-foreground">{(depositPreview.depositAmountSats / 1e8).toFixed(8)} BTC</p>
        <p className="text-caption text-gray mb-1.5">{depositPreview.depositAmountSats.toLocaleString()} sats</p>
        <div className="flex items-center gap-1.5 p-1.5 bg-background/50 rounded-[6px]">
          <code className="text-[10px] font-mono text-btc/60 truncate">{depositPreview.depositAddress.slice(0, 14)}...{depositPreview.depositAddress.slice(-14)}</code>
        </div>
      </div>

      <div className="p-3 bg-privacy/5 border border-privacy/20 rounded-[12px]">
        <button onClick={() => btcDeposit.setShowOpReturn(!btcDeposit.showOpReturn)} className="w-full flex items-center justify-between cursor-pointer">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-privacy/15 flex items-center justify-center"><Shield className="w-3 h-3 text-privacy" /></div>
            <span className="text-caption font-semibold text-privacy">ZK Metadata</span>
            <span className="text-[10px] text-privacy/50">64 bytes</span>
          </div>
          <ChevronDown className={cn("w-3.5 h-3.5 text-gray transition-transform duration-200", btcDeposit.showOpReturn && "rotate-180")} />
        </button>
        {btcDeposit.showOpReturn && (
          <div className="mt-2 pt-2 border-t border-privacy/10 space-y-1.5">
            <div><p className="text-[10px] text-gray mb-0.5">Ephemeral Public Key</p><code className="block text-[9px] font-mono text-privacy/50 break-all leading-relaxed">{depositPreview.opReturnHex.slice(0, 64)}</code></div>
            <div><p className="text-[10px] text-gray mb-0.5">Note Public Key</p><code className="block text-[9px] font-mono text-privacy/50 break-all leading-relaxed">{depositPreview.opReturnHex.slice(64)}</code></div>
          </div>
        )}
      </div>

      {changeAmount > 0 && (
        <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-full bg-gray/15 flex items-center justify-center"><Wallet className="w-3 h-3 text-gray" /></div>
            <span className="text-caption font-semibold text-gray-light">Change</span>
          </div>
          <p className="text-body2-semibold font-mono text-foreground">{(changeAmount / 1e8).toFixed(8)} BTC</p>
          <p className="text-caption text-gray">{changeAmount.toLocaleString()} sats</p>
        </div>
      )}

      <div className="p-3 rounded-[12px] bg-muted border border-gray/15 space-y-1.5">
        <div className="flex items-center justify-between text-caption">
          <span className="text-gray">Deposit</span>
          <span className="font-mono text-btc">{(depositPreview.depositAmountSats / 1e8).toFixed(8)} BTC</span>
        </div>
        {changeAmount > 0 && (
          <div className="flex items-center justify-between text-caption">
            <span className="text-gray">Change</span>
            <span className="font-mono text-foreground">{(changeAmount / 1e8).toFixed(8)} BTC</span>
          </div>
        )}
        <div className="flex items-center justify-between text-caption">
          <span className="text-gray">Network Fee</span>
          <span className="font-mono text-foreground">{estimatedFee.toLocaleString()} sats</span>
        </div>
        <div className="flex items-center justify-between text-caption pt-1.5 border-t border-gray/10">
          <span className="text-gray-light font-medium">Total</span>
          <span className="font-mono text-foreground font-semibold">{((depositPreview.depositAmountSats + estimatedFee) / 1e8).toFixed(8)} BTC</span>
        </div>
      </div>

      {insufficientFunds && (
        <div className="p-2.5 bg-error/10 border border-error/20 rounded-[10px]">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-error shrink-0" />
            <span className="text-caption text-error">Insufficient funds. Select more UTXOs or reduce amount.</span>
          </div>
        </div>
      )}

      {status === "error" && error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[10px]">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-caption text-red-400">{error}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={() => btcDeposit.setDepositPreview(null)} disabled={btcDeposit.walletDepositing}
          className="flex-1 py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2 bg-muted hover:bg-gray/20 text-foreground border border-gray/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
          Back
        </button>
        <button onClick={btcDeposit.confirmAndSign} disabled={btcDeposit.walletDepositing || insufficientFunds || btcDeposit.selectedUtxoKeys.size === 0}
          className={cn("flex-[2] py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer",
            "bg-btc hover:bg-btc/90 text-background disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed")}>
          {btcDeposit.walletDepositing ? (<><Loader2 className="w-4 h-4 animate-spin" />Signing...</>) : (<><Wallet className="w-4 h-4" />Confirm &amp; Sign</>)}
        </button>
      </div>
    </div>
  );
}
