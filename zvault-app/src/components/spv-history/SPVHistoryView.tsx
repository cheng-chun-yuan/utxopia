"use client";

import React, { useState, useMemo } from "react";
import {
  Database,
  ArrowDownToLine,
  ArrowUpFromLine,
  Send,
  ChevronDown,
  ChevronRight,
  Hash,
  Clock,
  Copy,
  Check,
  RefreshCw,
  TreeDeciduous,
  GitCommitHorizontal,
  ExternalLink,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { formatBtc, truncateMiddle } from "@/lib/utils/formatting";

// Activity types
type ActivityType = "deposit" | "transfer" | "withdraw";

// On-chain activity record
interface ActivityRecord {
  id: string;
  type: ActivityType;
  // Root transition
  prevRoot: string;
  newRoot: string;
  leafIndex: number;
  // Commitment data
  commitment?: string; // For deposits/transfers (new commitment added)
  nullifier?: string; // For transfers/withdraws (nullifier revealed)
  // Amount
  amountSats: number;
  // Transaction references
  solanaSignature: string;
  btcTxid?: string; // For deposits (SPV verified) or withdraws (BTC sent)
  // Metadata
  timestamp: number;
  blockSlot: number;
}

// Demo data showing all on-chain activity
const DEMO_ACTIVITIES: ActivityRecord[] = [
  {
    id: "1",
    type: "deposit",
    prevRoot: "0000000000000000000000000000000000000000000000000000000000000000",
    newRoot: "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd",
    leafIndex: 0,
    commitment: "c1a2b3d4e5f6789012345678901234567890123456789012345678901234dead",
    amountSats: 100000,
    solanaSignature: "5Ht8Dk4VTJkJxJ9vQ2xK8eLFmfpYRa3gH7jNvwZqX2yT9kL4aH6sP3nM1rC8wF5dG2",
    btcTxid: "8a5b3e65159dd86206ec722a1ed4847b729a744b162f644741b46c2b6b9dea8e",
    timestamp: Date.now() - 86400000 * 3,
    blockSlot: 298456123,
  },
  {
    id: "2",
    type: "deposit",
    prevRoot: "a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd",
    newRoot: "b2c3d4e5f6789012345678901234567890123456789012345678901234beef",
    leafIndex: 1,
    commitment: "d2e3f4a5b6c7890123456789012345678901234567890123456789012345cafe",
    amountSats: 50000,
    solanaSignature: "3Jk9Pl2qRs8tUv4wXy5zA6bC7dEf8gHi9jKl0mNoPqRs1tUv2wXy3zA4bC5d",
    btcTxid: "b548a007f3f9b5df71c8558a3040f37e3a5734d810d4eb021fe4a57bedcd2334",
    timestamp: Date.now() - 86400000 * 2,
    blockSlot: 298467890,
  },
  {
    id: "3",
    type: "transfer",
    prevRoot: "b2c3d4e5f6789012345678901234567890123456789012345678901234beef",
    newRoot: "c3d4e5f6789012345678901234567890123456789012345678901234c0de",
    leafIndex: 2,
    commitment: "e3f4a5b6c7d8901234567890123456789012345678901234567890123456feed",
    nullifier: "n1a2b3c4d5e6f7890123456789012345678901234567890123456789012340001",
    amountSats: 100000,
    solanaSignature: "4Kl0Qm3rSt9uVw5xYz6aB7cD8eF9gHiJkLmNoPqRsTuVwXyZaB1cD2eF3g",
    timestamp: Date.now() - 86400000,
    blockSlot: 298512345,
  },
  {
    id: "4",
    type: "deposit",
    prevRoot: "c3d4e5f6789012345678901234567890123456789012345678901234c0de",
    newRoot: "d4e5f6a7b8c9012345678901234567890123456789012345678901234d00d",
    leafIndex: 3,
    commitment: "f4a5b6c7d8e9012345678901234567890123456789012345678901234567babe",
    amountSats: 25000,
    solanaSignature: "5Lm1Rn4sUv0wXy6zA7bC8dEf9gHiJkLmNoPqRsTuVwXyZaB1cD2eF3gH4i",
    btcTxid: "c659b118b5f0c6ef82d9669b4151f48f4b6845e921e5fc132gf5b68ceef3445",
    timestamp: Date.now() - 43200000,
    blockSlot: 298534567,
  },
  {
    id: "5",
    type: "withdraw",
    prevRoot: "d4e5f6a7b8c9012345678901234567890123456789012345678901234d00d",
    newRoot: "e5f6a7b8c9d0123456789012345678901234567890123456789012345e00e",
    leafIndex: 4,
    nullifier: "n2b3c4d5e6f7a8901234567890123456789012345678901234567890123450002",
    amountSats: 50000,
    solanaSignature: "6Mn2So5tVw1xYz7aB8cD9eF0gHiJkLmNoPqRsTuVwXyZaB1cD2eF3gH4iJ5k",
    btcTxid: "d760c229c6g1d7fg93e0770c5262g59g5c7956fa032f6gd243h6c79dff4556",
    timestamp: Date.now() - 7200000,
    blockSlot: 298556789,
  },
  {
    id: "6",
    type: "transfer",
    prevRoot: "e5f6a7b8c9d0123456789012345678901234567890123456789012345e00e",
    newRoot: "f6a7b8c9d0e1234567890123456789012345678901234567890123456f00f",
    leafIndex: 5,
    commitment: "a5b6c7d8e9f0123456789012345678901234567890123456789012345678ace",
    nullifier: "n3c4d5e6f7a8b9012345678901234567890123456789012345678901234560003",
    amountSats: 25000,
    solanaSignature: "7No3Tp6uWx2yZa8bC9dE0fG1hIjKlMnOpQrStUvWxYzAb2cD3eF4gH5iJ6kL",
    timestamp: Date.now() - 1800000,
    blockSlot: 298567890,
  },
];

// Copy button component
function CopyButton({ text, size = "sm" }: { text: string; size?: "sm" | "xs" }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      onClick={() => copy(text)}
      className={cn(
        "p-1 rounded hover:bg-gray/20 transition-colors",
        size === "xs" ? "p-0.5" : "p-1"
      )}
    >
      {copied ? (
        <Check className={cn("text-green-400", size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5")} />
      ) : (
        <Copy className={cn("text-gray", size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5")} />
      )}
    </button>
  );
}

// Activity type config
const activityConfig = {
  deposit: {
    icon: ArrowDownToLine,
    label: "Deposit",
    color: "text-green-400",
    bg: "bg-green-400/10",
    border: "border-green-400/20",
    description: "BTC deposited via SPV proof, commitment added to tree",
  },
  transfer: {
    icon: Send,
    label: "Transfer",
    color: "text-purple-400",
    bg: "bg-purple-400/10",
    border: "border-purple-400/20",
    description: "Nullifier revealed, new commitment added (stealth send)",
  },
  withdraw: {
    icon: ArrowUpFromLine,
    label: "Withdraw",
    color: "text-orange-400",
    bg: "bg-orange-400/10",
    border: "border-orange-400/20",
    description: "Nullifier revealed, BTC sent to recipient",
  },
};

// Time ago helper
function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Activity Card
function ActivityCard({
  record,
  isExpanded,
  onToggle,
}: {
  record: ActivityRecord;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const config = activityConfig[record.type];
  const Icon = config.icon;
  const timeAgo = getTimeAgo(record.timestamp);

  return (
    <div className={cn("border rounded-xl overflow-hidden", config.border)}>
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full p-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-lg", config.bg)}>
            <Icon className={cn("w-4 h-4", config.color)} />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2">
              <span className={cn("text-sm font-medium", config.color)}>{config.label}</span>
              <span className="text-sm text-white">{formatBtc(record.amountSats)} BTC</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray mt-0.5">
              <span>Leaf #{record.leafIndex}</span>
              <span>•</span>
              <span>Slot {record.blockSlot.toLocaleString()}</span>
              <span>•</span>
              <span>{timeAgo}</span>
            </div>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-gray" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray" />
        )}
      </button>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-gray/15 bg-muted/30 p-3 space-y-3">
          {/* Root Transition */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <TreeDeciduous className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-xs font-medium text-emerald-400">Merkle Root Transition</span>
            </div>
            <div className="pl-2 border-l-2 border-emerald-400/30 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray w-12">Before:</span>
                <code className="text-[10px] font-mono text-gray-light">
                  {truncateMiddle(record.prevRoot, 16)}
                </code>
                <CopyButton text={record.prevRoot} size="xs" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-emerald-400 w-12">After:</span>
                <code className="text-[10px] font-mono text-emerald-400">
                  {truncateMiddle(record.newRoot, 16)}
                </code>
                <CopyButton text={record.newRoot} size="xs" />
              </div>
            </div>
          </div>

          {/* Commitment (for deposits/transfers) */}
          {record.commitment && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Hash className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs font-medium text-blue-400">New Commitment</span>
              </div>
              <div className="flex items-center gap-2 pl-5">
                <code className="text-[10px] font-mono text-gray-light">
                  {truncateMiddle(record.commitment, 20)}
                </code>
                <CopyButton text={record.commitment} size="xs" />
              </div>
            </div>
          )}

          {/* Nullifier (for transfers/withdraws) */}
          {record.nullifier && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <GitCommitHorizontal className="w-3.5 h-3.5 text-red-400" />
                <span className="text-xs font-medium text-red-400">Nullifier Revealed</span>
              </div>
              <div className="flex items-center gap-2 pl-5">
                <code className="text-[10px] font-mono text-gray-light">
                  {truncateMiddle(record.nullifier, 20)}
                </code>
                <CopyButton text={record.nullifier} size="xs" />
              </div>
            </div>
          )}

          {/* Transaction Links */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-gray/10">
            <a
              href={`https://orbmarkets.io/tx/${record.solanaSignature}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-1 rounded bg-sol/10 text-sol text-[10px] hover:bg-sol/20"
            >
              <Layers className="w-3 h-3" />
              Solana TX
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
            {record.btcTxid && (
              <a
                href={`https://mempool.space/testnet/tx/${record.btcTxid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 rounded bg-orange-500/10 text-orange-400 text-[10px] hover:bg-orange-500/20"
              >
                <Database className="w-3 h-3" />
                BTC TX
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </div>

          {/* Description */}
          <p className="text-[10px] text-gray italic">{config.description}</p>
        </div>
      )}
    </div>
  );
}

// Main component
export function SPVHistoryView() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<ActivityType | "all">("all");

  // Sort by timestamp descending and filter
  const filteredRecords = useMemo(() => {
    const sorted = [...DEMO_ACTIVITIES].sort((a, b) => b.timestamp - a.timestamp);
    if (filter === "all") return sorted;
    return sorted.filter((r) => r.type === filter);
  }, [filter]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setIsRefreshing(false);
  };

  // Stats
  const stats = useMemo(() => {
    const deposits = DEMO_ACTIVITIES.filter((r) => r.type === "deposit");
    const transfers = DEMO_ACTIVITIES.filter((r) => r.type === "transfer");
    const withdraws = DEMO_ACTIVITIES.filter((r) => r.type === "withdraw");
    const totalDeposited = deposits.reduce((sum, r) => sum + r.amountSats, 0);
    const totalWithdrawn = withdraws.reduce((sum, r) => sum + r.amountSats, 0);
    return {
      deposits: deposits.length,
      transfers: transfers.length,
      withdraws: withdraws.length,
      totalDeposited,
      totalWithdrawn,
      currentRoot: DEMO_ACTIVITIES.sort((a, b) => b.timestamp - a.timestamp)[0]?.newRoot || "",
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-emerald-400" />
          <p className="text-lg font-semibold text-white">On-Chain Activity</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="p-2 rounded-lg bg-muted border border-gray/15 hover:bg-card"
        >
          <RefreshCw className={cn("h-4 w-4 text-gray", isRefreshing && "animate-spin")} />
        </button>
      </div>

      {/* Current Root */}
      <div className="p-3 bg-emerald-400/5 border border-emerald-400/20 rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TreeDeciduous className="w-4 h-4 text-emerald-400" />
            <span className="text-xs text-emerald-400">Current Merkle Root</span>
          </div>
          <div className="flex items-center gap-1">
            <code className="text-xs font-mono text-emerald-400">
              {truncateMiddle(stats.currentRoot, 16)}
            </code>
            <CopyButton text={stats.currentRoot} size="xs" />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-2 bg-green-400/10 border border-green-400/20 rounded-lg text-center">
          <p className="text-sm font-bold text-green-400">{stats.deposits}</p>
          <p className="text-[10px] text-gray">Deposits</p>
        </div>
        <div className="p-2 bg-purple-400/10 border border-purple-400/20 rounded-lg text-center">
          <p className="text-sm font-bold text-purple-400">{stats.transfers}</p>
          <p className="text-[10px] text-gray">Transfers</p>
        </div>
        <div className="p-2 bg-orange-400/10 border border-orange-400/20 rounded-lg text-center">
          <p className="text-sm font-bold text-orange-400">{stats.withdraws}</p>
          <p className="text-[10px] text-gray">Withdraws</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-1 p-1 bg-muted border border-gray/15 rounded-lg">
        {(["all", "deposit", "transfer", "withdraw"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "flex-1 px-2 py-1.5 rounded text-xs transition-colors",
              filter === f
                ? "bg-privacy/10 text-privacy border border-privacy/20"
                : "text-gray hover:text-white"
            )}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}s
          </button>
        ))}
      </div>

      {/* Activity List */}
      <div className="space-y-2">
        {filteredRecords.map((record) => (
          <ActivityCard
            key={record.id}
            record={record}
            isExpanded={expandedId === record.id}
            onToggle={() => setExpandedId(expandedId === record.id ? null : record.id)}
          />
        ))}
      </div>

      {/* Demo Notice */}
      <div className="p-2 bg-purple-500/10 border border-purple-500/20 rounded-lg">
        <p className="text-[10px] text-purple-400 text-center">
          Demo data showing merkle tree state changes across all zVault operations
        </p>
      </div>

      {/* Legend */}
      <div className="p-3 bg-muted border border-gray/15 rounded-lg space-y-2">
        <p className="text-xs text-gray font-medium">How it works:</p>
        <div className="grid grid-cols-1 gap-1 text-[10px] text-gray">
          <div className="flex items-center gap-2">
            <ArrowDownToLine className="w-3 h-3 text-green-400" />
            <span><span className="text-green-400">Deposit</span> - BTC verified via SPV, commitment added</span>
          </div>
          <div className="flex items-center gap-2">
            <Send className="w-3 h-3 text-purple-400" />
            <span><span className="text-purple-400">Transfer</span> - Nullifier spent, new commitment for recipient</span>
          </div>
          <div className="flex items-center gap-2">
            <ArrowUpFromLine className="w-3 h-3 text-orange-400" />
            <span><span className="text-orange-400">Withdraw</span> - Nullifier spent, BTC sent to address</span>
          </div>
        </div>
      </div>
    </div>
  );
}
