"use client";

import { useUiMode } from "@/hooks/use-ui-mode";

export function AdvancedModeBadge() {
  const { isAdvanced } = useUiMode();
  if (!isAdvanced) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-privacy/10 text-privacy text-[10px] font-medium uppercase tracking-wide">
      Advanced
    </span>
  );
}
