"use client";

import { Fragment } from "react";
import { ChevronRight, Shield } from "lucide-react";

const STEPS = [
  { step: "1", label: "Deposit" },
  { step: "2", label: "Send" },
  { step: "3", label: "Cash Out" },
];

export function VaultGuide() {
  return (
    <div className="px-3 py-3 bg-muted/30 rounded-[10px] mb-4">
      <div className="flex items-center gap-4">
        {STEPS.map((s, i) => (
          <Fragment key={s.step}>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold font-mono text-privacy/40">{s.step}</span>
              <span className="text-[11px] text-gray/50">{s.label}</span>
            </div>
            {i < 2 && <ChevronRight className="w-3 h-3 text-gray/15 shrink-0" />}
          </Fragment>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <Shield className="w-3 h-3 text-privacy/40" />
          <span className="text-[10px] text-privacy/40 font-medium">ZK</span>
        </div>
      </div>
    </div>
  );
}
