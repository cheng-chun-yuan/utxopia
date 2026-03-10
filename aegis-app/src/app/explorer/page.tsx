"use client";

import { useState, Suspense, useCallback, Fragment } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  ChevronDown,
  ExternalLink,
  Loader2,
  Search,
  Shield,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import {
  useDeposits,
  useTransfers,
  useRedemptions,
} from "@/hooks/use-explorer";

// =============================================================================
// Helpers
// =============================================================================

function truncate(str: string, start = 6, end = 4): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

function timeAgo(timestamp: number): string {
  if (timestamp === 0) return "—";
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

/** Decode a hex scriptPubKey to a testnet bech32m address */
function scriptToAddress(hexScript: string): string | null {
  try {
    const bytes = new Uint8Array(hexScript.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    if (bytes.length < 4) return null;
    const version = bytes[0] === 0x00 ? 0 : bytes[0] - 0x50;
    if (version < 0 || version > 16) return null;
    const progLen = bytes[1];
    if (bytes.length < 2 + progLen) return null;
    const program = bytes.slice(2, 2 + progLen);
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const data5: number[] = [version];
    let acc = 0, bits = 0;
    for (const b of program) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data5.push((acc >> bits) & 31); } }
    if (bits > 0) data5.push((acc << (5 - bits)) & 31);
    const hrp = "tb";
    const useBech32m = version > 0;
    function polymod(values: number[]): number {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      let chk = 1;
      for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; }
      return chk;
    }
    function hrpExpand(h: string): number[] {
      const r: number[] = [];
      for (const c of h) r.push(c.charCodeAt(0) >> 5);
      r.push(0);
      for (const c of h) r.push(c.charCodeAt(0) & 31);
      return r;
    }
    const checkConst = useBech32m ? 0x2bc830a3 : 1;
    const values = [...hrpExpand(hrp), ...data5, 0, 0, 0, 0, 0, 0];
    const pm = polymod(values) ^ checkConst;
    const checksum: number[] = [];
    for (let i = 0; i < 6; i++) checksum.push((pm >> (5 * (5 - i))) & 31);
    return hrp + "1" + [...data5, ...checksum].map(v => CHARSET[v]).join("");
  } catch {
    return null;
  }
}

// =============================================================================
// Shared Components
// =============================================================================

type TabType = "deposits" | "transfers" | "withdrawals";

const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
  { id: "deposits", label: "Deposits", icon: <ArrowDownToLine className="w-4 h-4" /> },
  { id: "transfers", label: "Transfers", icon: <ArrowUpDown className="w-4 h-4" /> },
  { id: "withdrawals", label: "Withdrawals", icon: <ArrowUpFromLine className="w-4 h-4" /> },
];

function TabBar({ activeTab, onTabChange, counts }: {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  counts: Record<TabType, number>;
}) {
  const colorMap: Record<TabType, string> = {
    deposits: "bg-green-500/10 text-green-400 border-green-500/20",
    transfers: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    withdrawals: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  };

  return (
    <div className="flex gap-1 p-1 bg-muted border border-gray/15 rounded-[12px]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2.5 rounded-[10px] text-xs sm:text-sm transition-colors",
            activeTab === tab.id
              ? colorMap[tab.id]
              : "text-gray hover:text-gray-light hover:bg-gray/10"
          )}
        >
          {tab.icon}
          <span className="hidden sm:inline">{tab.label}</span>
          <span className="sm:hidden">{tab.label.slice(0, 3)}</span>
          {counts[tab.id] > 0 && (
            <span className="min-w-[22px] h-[22px] px-1.5 flex items-center justify-center text-xs rounded-full bg-gray/20 text-gray-light font-medium">
              {counts[tab.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn("px-4 py-3 text-left text-caption text-gray font-medium whitespace-nowrap", className)}>
      {children}
    </th>
  );
}

function Td({ children, className, colSpan }: { children?: React.ReactNode; className?: string; colSpan?: number }) {
  return (
    <td className={cn("px-4 py-3.5 whitespace-nowrap", className)} colSpan={colSpan}>
      {children}
    </td>
  );
}

function SolanaLink({ signature }: { signature: string }) {
  return (
    <a
      href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sol hover:text-sol/80 transition-colors"
      aria-label="View transaction"
    >
      <ExternalLink className="w-3.5 h-3.5" />
    </a>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-2 text-gray">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-body2">Loading on-chain data...</span>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-[12px] space-y-2">
      <p className="text-body2 text-red-400">{message}</p>
      <button onClick={onRetry} className="text-caption text-red-400 hover:text-red-300 underline transition-colors">Retry</button>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Search className="w-8 h-8 text-gray/50 mb-3" />
      <p className="text-body2 text-gray">No {label} found</p>
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-caption text-gray hover:text-gray-light transition-colors cursor-pointer" aria-label="Refresh">
      <RefreshCw className="w-3.5 h-3.5" />
    </button>
  );
}

// =============================================================================
// Deposits Tab
// =============================================================================

function DepositsTab() {
  const { deposits, isLoading, error, refresh } = useDeposits();

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (deposits.length === 0) return <EmptyState label="deposits" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{deposits.length} deposit(s)</span>
        <RefreshButton onClick={refresh} />
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-gray/15">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-gray/15">
              <Th>Source</Th>
              <Th>Tx ID</Th>
              <Th>Destination</Th>
              <Th>Amount</Th>
              <Th>Leaf</Th>
              <Th>Time</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {deposits.map((d) => (
              <tr key={d.commitment} className="hover:bg-gray/5 transition-colors">
                <Td>
                  <div className="flex items-center gap-1.5">
                    <BitcoinIcon className="w-4 h-4 text-btc" />
                    <span className="text-body2 text-foreground font-medium">BTC</span>
                  </div>
                </Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <code className="text-caption font-mono text-foreground">{truncate(d.txSignature, 6, 4)}</code>
                    <CopyButton text={d.txSignature} label="Tx" variant="default" iconSize="sm" />
                  </div>
                </Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <Shield className="w-4 h-4 text-purple-400" />
                    <span className="text-body2 text-foreground font-medium">zkBTC</span>
                  </div>
                </Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <BitcoinIcon className="w-3.5 h-3.5 text-btc" />
                    <span className="text-body2 text-foreground font-mono">{d.amountBtc}</span>
                  </div>
                </Td>
                <Td>
                  <span className="text-caption text-foreground font-mono">#{d.leafIndex}</span>
                </Td>
                <Td>
                  <span className="text-caption text-gray">{timeAgo(d.timestamp)}</span>
                </Td>
                <Td>
                  {d.txSignature && <SolanaLink signature={d.txSignature} />}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Transfers Tab — grouped by transaction
// =============================================================================

function outputLabel(index: number, total: number): { label: string; color: string } {
  if (total === 1) return { label: "Send", color: "text-purple-400" };
  if (total === 2) return index === 0 ? { label: "Send", color: "text-purple-400" } : { label: "Change", color: "text-gray" };
  if (index === 0) return { label: "Send", color: "text-purple-400" };
  if (index === total - 1) return { label: "Change", color: "text-gray" };
  return { label: "Fee", color: "text-orange-400" };
}

function TransfersTab() {
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
      <div className="overflow-x-auto rounded-[12px] border border-gray/15">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-gray/15">
              <Th className="w-[40px]" />
              <Th>Type</Th>
              <Th>Tx ID</Th>
              <Th>Outputs</Th>
              <Th>Time</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {transfers.map((tx) => {
              const isOpen = expanded.has(tx.txSignature);
              return (
                <Fragment key={tx.txSignature}>
                  <tr
                    className="hover:bg-gray/5 transition-colors cursor-pointer"
                    onClick={() => toggle(tx.txSignature)}
                  >
                    <Td>
                      <ChevronDown
                        className={cn(
                          "w-4 h-4 text-gray transition-transform",
                          isOpen && "rotate-180"
                        )}
                      />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Shield className="w-4 h-4 text-purple-400" />
                        <span className="text-body2 text-foreground font-medium">Private Send</span>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <code className="text-caption font-mono text-foreground">{truncate(tx.txSignature, 6, 4)}</code>
                        <CopyButton text={tx.txSignature} label="Tx" variant="default" iconSize="sm" />
                      </div>
                    </Td>
                    <Td>
                      <span className="text-caption text-gray bg-gray/10 px-2 py-0.5 rounded-full">
                        {tx.outputs.length} output{tx.outputs.length !== 1 ? "s" : ""}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-caption text-gray">{timeAgo(tx.timestamp)}</span>
                    </Td>
                    <Td>
                      <SolanaLink signature={tx.txSignature} />
                    </Td>
                  </tr>
                  {isOpen && tx.outputs.map((out, i) => {
                    const { label, color } = outputLabel(i, tx.outputs.length);
                    return (
                      <tr key={out.leafIndex} className="bg-muted/30">
                        <Td />
                        <Td>
                          <span className={cn("text-caption font-medium", color)}>{label}</span>
                        </Td>
                        <Td colSpan={2}>
                          <div className="flex items-center gap-1.5">
                            <code className="text-caption font-mono text-foreground">{truncate(out.commitment, 8, 6)}</code>
                            <CopyButton text={out.commitment} label="Commitment" variant="default" iconSize="sm" />
                          </div>
                        </Td>
                        <Td>
                          <span className="text-caption text-foreground font-mono">Leaf #{out.leafIndex}</span>
                        </Td>
                        <Td />
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Withdrawals Tab
// =============================================================================

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  Pending: { bg: "bg-orange-500/10 border-orange-500/20", text: "text-orange-400" },
  Processing: { bg: "bg-blue-500/10 border-blue-500/20", text: "text-blue-400" },
  Failed: { bg: "bg-red-500/10 border-red-500/20", text: "text-red-400" },
};

function WithdrawalsTab() {
  const { redemptions, isLoading, error, refresh } = useRedemptions();

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (redemptions.length === 0) return <EmptyState label="withdrawals" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{redemptions.length} withdrawal(s)</span>
        <RefreshButton onClick={refresh} />
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-gray/15">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-gray/15">
              <Th>Type</Th>
              <Th>Status</Th>
              <Th>Destination</Th>
              <Th>Amount</Th>
              <Th>Requester</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {redemptions.map((r) => {
              const statusStyle = STATUS_STYLES[r.status] ?? STATUS_STYLES.Pending;
              const btcAddr = r.btcScript ? scriptToAddress(r.btcScript) : null;
              const isBtcWithdraw = !!r.btcScript;
              return (
                <tr key={r.pubkey} className="hover:bg-gray/5 transition-colors">
                  <Td>
                    {isBtcWithdraw ? (
                      <div className="flex items-center gap-1.5">
                        <BitcoinIcon className="w-4 h-4 text-btc" />
                        <span className="text-body2 text-foreground font-medium">Bitcoin Withdraw</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Shield className="w-4 h-4 text-sol" />
                        <span className="text-body2 text-foreground font-medium">Solana Withdraw</span>
                      </div>
                    )}
                  </Td>
                  <Td>
                    <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded-full text-caption border font-medium", statusStyle.bg, statusStyle.text)}>
                      {r.status}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      {isBtcWithdraw ? (
                        <BitcoinIcon className="w-4 h-4 text-btc" />
                      ) : (
                        <Shield className="w-4 h-4 text-sol" />
                      )}
                      {btcAddr ? (
                        <>
                          <code className="text-caption font-mono text-foreground">{truncate(btcAddr, 8, 6)}</code>
                          <CopyButton text={btcAddr} label="BTC Address" variant="default" iconSize="sm" />
                        </>
                      ) : (
                        <span className="text-caption text-gray">—</span>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <BitcoinIcon className="w-3.5 h-3.5 text-btc" />
                      <span className="text-body2 text-foreground font-mono">
                        {(Number(r.amountSats) / 1e8).toFixed(8)}
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <code className="text-caption font-mono text-foreground">{truncate(r.requester, 6, 4)}</code>
                      <CopyButton text={r.requester} label="Requester" variant="default" iconSize="sm" />
                    </div>
                  </Td>
                  <Td>
                    <a
                      href={`https://explorer.solana.com/address/${r.pubkey}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sol hover:text-sol/80 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Main Page
// =============================================================================

function ExplorerContent() {
  const [activeTab, setActiveTab] = useState<TabType>("deposits");
  const { deposits } = useDeposits();
  const { transfers } = useTransfers();
  const { redemptions } = useRedemptions();

  const counts: Record<TabType, number> = {
    deposits: deposits.length,
    transfers: transfers.length,
    withdrawals: redemptions.length,
  };

  return (
    <>
      <div className="mb-4">
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} counts={counts} />
      </div>
      {activeTab === "deposits" && <DepositsTab />}
      {activeTab === "transfers" && <TransfersTab />}
      {activeTab === "withdrawals" && <WithdrawalsTab />}
    </>
  );
}

export default function ExplorerPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay">
      <div className="container mx-auto px-4 py-8 relative z-10 max-w-5xl">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="p-2 rounded-[12px] bg-gradient-to-br from-btc/20 to-privacy/20 border border-btc/20">
              <div className="relative">
                <BitcoinIcon className="h-6 w-6 btc-glow" />
                <Shield className="h-3 w-3 text-privacy absolute -bottom-1 -right-1" />
              </div>
            </div>
            <span className="text-heading6 text-foreground">Aegis</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/vault" className="text-body2 text-gray hover:text-gray-light transition-colors">Vault</Link>
            <Link href="/docs" className="text-body2 text-gray hover:text-gray-light transition-colors">Docs</Link>
          </div>
        </header>

        {/* Title */}
        <div className="mb-6 flex items-center gap-3">
          <div className="p-2 rounded-[10px] bg-privacy/10 border border-privacy/20">
            <Search className="w-5 h-5 text-privacy" />
          </div>
          <div>
            <h1 className="text-heading5 text-foreground">Explorer</h1>
            <p className="text-caption text-gray">Browse all on-chain Aegis activity on Solana devnet</p>
          </div>
        </div>

        <Suspense fallback={<LoadingState />}>
          <ExplorerContent />
        </Suspense>

        {/* Privacy Note */}
        <div className="mt-6 p-3 bg-privacy/5 border border-privacy/15 rounded-[12px]">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-privacy" />
            <span className="text-caption text-privacy">Privacy Preserved</span>
          </div>
          <p className="text-caption text-gray">
            Transfer amounts are encrypted with zero-knowledge proofs. Only commitments and
            nullifiers are visible on-chain — no amounts or sender/recipient information is exposed.
          </p>
        </div>

        <footer className="mt-8 pt-6 border-t border-gray/15">
          <div className="flex justify-between items-center">
            <Link href="/" className="text-caption text-gray hover:text-gray-light transition-colors">Aegis</Link>
            <a href="https://zeusnetwork.xyz/" target="_blank" rel="noopener noreferrer" className="text-caption text-gray hover:text-gray-light transition-colors flex items-center gap-1.5">
              Powered by <img src="/zeus_network.svg" alt="Zeus Network" className="w-4 h-4" />Zeus Network
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
