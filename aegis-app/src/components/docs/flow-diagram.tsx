import {
  Bitcoin,
  GitBranch,
  TreePine,
  Layers,
  Network,
} from "lucide-react";

const STEPS = [
  { icon: Bitcoin, label: "BTC Deposit", sub: "Taproot Address", color: "text-btc", border: "border-btc/20" },
  { icon: GitBranch, label: "SPV Verify", sub: "On-chain Proof", color: "text-sol", border: "border-sol/20" },
  { icon: TreePine, label: "Shielded Pool", sub: "Poseidon Commitment", color: "text-privacy", border: "border-privacy/20" },
  { icon: Layers, label: "JoinSplit", sub: "ZK Transfer", color: "text-sol", border: "border-sol/20" },
  { icon: Network, label: "FROST Withdraw", sub: "Threshold Sign", color: "text-btc", border: "border-btc/20" },
];

export function FlowDiagram() {
  return (
    <div className="w-full rounded-xl border border-gray/10 bg-muted/20 p-4 sm:p-6 relative overflow-hidden">
      <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-3">
        {STEPS.map((step, i) => (
          <div key={step.label} className="flex items-center gap-3">
            <div className="flex flex-col items-center gap-1.5">
              <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl border ${step.border} bg-background/40 flex items-center justify-center`}>
                <step.icon className={`w-4 h-4 sm:w-5 sm:h-5 ${step.color}`} />
              </div>
              <span className="text-[9px] sm:text-[10px] font-medium text-foreground">{step.label}</span>
              <span className="text-[7px] sm:text-[8px] font-mono text-gray/40">{step.sub}</span>
            </div>
            {i < 4 && <div className="hidden sm:block w-6 md:w-8 h-px bg-gradient-to-r from-gray/20 to-gray/5" />}
          </div>
        ))}
      </div>
    </div>
  );
}
