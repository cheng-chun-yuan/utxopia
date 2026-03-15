import {
  Bitcoin,
  GitBranch,
  TreePine,
  Layers,
  Network,
  ChevronRight,
} from "lucide-react";

const STEPS = [
  { icon: Bitcoin, label: "BTC Deposit", sub: "Taproot Address", color: "text-btc", border: "border-btc/20" },
  { icon: GitBranch, label: "SPV Verify", sub: "On-chain Proof", color: "text-sol", border: "border-sol/20" },
  { icon: TreePine, label: "Shielded Pool", sub: "Poseidon Commitment", color: "text-privacy", border: "border-privacy/20" },
  { icon: Layers, label: "JoinSplit", sub: "ZK Transfer", color: "text-sol", border: "border-sol/20" },
  { icon: Network, label: "FROST Withdraw", sub: "Threshold Sign", color: "text-btc", border: "border-btc/20" },
];

function StepNode({ step }: { step: typeof STEPS[number] }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl border ${step.border} bg-background/40 flex items-center justify-center`}>
        <step.icon className={`w-4 h-4 sm:w-5 sm:h-5 ${step.color}`} />
      </div>
      <span className="text-[10px] sm:text-xs font-medium text-foreground">{step.label}</span>
      <span className="text-[8px] sm:text-[9px] font-mono text-gray/40">{step.sub}</span>
    </div>
  );
}

function Arrow() {
  return <ChevronRight className="w-4 h-4 text-gray/25 shrink-0" />;
}

export function FlowDiagram() {
  return (
    <div className="w-full rounded-xl border border-gray/10 bg-muted/20 p-4 sm:p-6 relative overflow-hidden">
      {/* Desktop: single row */}
      <div className="hidden sm:flex items-center justify-center gap-3">
        {STEPS.map((step, i) => (
          <div key={step.label} className="flex items-center gap-3">
            <StepNode step={step} />
            {i < 4 && <Arrow />}
          </div>
        ))}
      </div>

      {/* Mobile: 3 + 2 grid */}
      <div className="flex flex-col items-center gap-4 sm:hidden">
        <div className="flex items-center justify-center gap-3">
          <StepNode step={STEPS[0]} />
          <Arrow />
          <StepNode step={STEPS[1]} />
          <Arrow />
          <StepNode step={STEPS[2]} />
        </div>
        <div className="flex items-center justify-center gap-3">
          <StepNode step={STEPS[3]} />
          <Arrow />
          <StepNode step={STEPS[4]} />
        </div>
      </div>
    </div>
  );
}
