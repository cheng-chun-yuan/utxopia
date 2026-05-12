"use client";

import { useUiMode } from "@/hooks/use-ui-mode";
import { cn } from "@/lib/utils";
import { NetworkSelector } from "@/components/settings/network-selector";

export function PreferencesForm() {
  const { isAdvanced } = useUiMode();

  // Phase 1: toggle is read-only, labeled "Coming soon".
  // Flip to interactive in Phase 2 when multi-output ships.
  const advancedDisabled = true;

  return (
    <div className="space-y-8">
      <NetworkSelector />

      <div
        className={cn(
          "flex items-start justify-between gap-4 p-4 rounded-xl border",
          "border-gray/15 bg-muted/20",
          advancedDisabled && "opacity-70",
        )}
      >
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Advanced send</h3>
            {advancedDisabled && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                Coming soon
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Multi-output sends (batch to multiple recipients in one ZK proof),
            custom Bitcoin fee rate, and manual coin selection.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isAdvanced}
          disabled={advancedDisabled}
          className={cn(
            "shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors",
            isAdvanced ? "bg-privacy" : "bg-muted",
            advancedDisabled && "cursor-not-allowed",
          )}
        >
          <span
            className={cn(
              "block w-5 h-5 rounded-full bg-background transition-transform",
              isAdvanced ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </div>
  );
}
