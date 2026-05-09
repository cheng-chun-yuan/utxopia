import { CheckCircle2, XCircle } from "lucide-react";
import { GradientBorderCard } from "@/components/ui/gradient-border-card";

interface ComparisonRowData {
  label: string;
  traditional: string;
  privateBtc: string;
}

const ROWS: ComparisonRowData[] = [
  { label: "Balances", traditional: "Visible on-chain", privateBtc: "Hidden as commitments" },
  { label: "Transfers", traditional: "Traceable amounts", privateBtc: "ZK-proven, zero knowledge" },
  { label: "Addresses", traditional: "Linkable & reusable", privateBtc: "One-time stealth addresses" },
  { label: "Deposits", traditional: "Public token minting", privateBtc: "Shielded Merkle insertion" },
  { label: "Withdrawals", traditional: "Traceable burn + send", privateBtc: "Unlinkable via nullifiers" },
  { label: "Custody", traditional: "Multisig / MPC", privateBtc: "Ika dWallet · Solana-controlled" },
];

function ComparisonRow({ label, traditional, privateBtc }: ComparisonRowData) {
  return (
    <>
      {/* Desktop: 3-column row */}
      <div className="hidden sm:grid grid-cols-3 gap-4 py-3 border-b border-gray/5 last:border-0">
        <span className="text-sm text-gray-light font-medium">{label}</span>
        <div className="flex items-center gap-1.5">
          <XCircle className="w-3.5 h-3.5 text-red-400/60 shrink-0" />
          <span className="text-[12px] text-gray">{traditional}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-privacy/60 shrink-0" />
          <span className="text-[12px] text-privacy/70">{privateBtc}</span>
        </div>
      </div>

      {/* Mobile: stacked layout */}
      <div className="sm:hidden py-3 border-b border-gray/5 last:border-0 space-y-1.5">
        <span className="text-sm text-gray-light font-medium block">{label}</span>
        <div className="flex items-center gap-1.5 pl-2">
          <XCircle className="w-3 h-3 text-red-400/60 shrink-0" />
          <span className="text-[11px] text-gray">{traditional}</span>
        </div>
        <div className="flex items-center gap-1.5 pl-2">
          <CheckCircle2 className="w-3 h-3 text-privacy/60 shrink-0" />
          <span className="text-[11px] text-privacy/70">{privateBtc}</span>
        </div>
      </div>
    </>
  );
}

export function ComparisonTable() {
  return (
    <GradientBorderCard hoverGlow="rgba(255,100,100,0.06)" className="group">
      {/* Desktop header */}
      <div className="hidden sm:grid grid-cols-3 gap-4 pb-3 mb-2 border-b border-gray/10">
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray/40">Aspect</span>
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray/40">Traditional Bridges</span>
        <span className="text-[11px] font-mono uppercase tracking-wider text-privacy/50">Privacy Coin</span>
      </div>
      {/* Mobile header */}
      <div className="sm:hidden pb-3 mb-2 border-b border-gray/10">
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray/40">Comparison</span>
      </div>
      {ROWS.map((row) => (
        <ComparisonRow key={row.label} {...row} />
      ))}
    </GradientBorderCard>
  );
}
