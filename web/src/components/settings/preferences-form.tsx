"use client";

import { Loader2 } from "lucide-react";
import { useUiMode } from "@/hooks/use-ui-mode";
import { useSnsName } from "@/hooks/use-sns-name";
import { cn } from "@/lib/utils";
import { NetworkSelector } from "@/components/settings/network-selector";
import { SnsComplianceFlags } from "@utxopia/sdk";

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

      <AuditorDisclosableToggle />
    </div>
  );
}

/**
 * Toggle the AUDITOR_DISCLOSABLE bit on the user's `.btcpro.sol` SNS
 * subdomain. Senders looking up your name will see a chip indicating
 * you've opted in to receiving outgoing audit memos. The flag itself is
 * just a single byte on-chain — your viewing keys are NOT shared until
 * you explicitly issue a `DelegatedViewKey` to an auditor (separate
 * flow).
 */
function AuditorDisclosableToggle() {
  const sns = useSnsName();
  const enabled = (sns.complianceFlags & SnsComplianceFlags.AUDITOR_DISCLOSABLE) !== 0;
  const disabled = !sns.hasRegisteredSnsName || sns.isRegistering || sns.isLoading;

  async function handleToggle() {
    if (disabled) return;
    const next = enabled
      ? sns.complianceFlags & ~SnsComplianceFlags.AUDITOR_DISCLOSABLE
      : sns.complianceFlags | SnsComplianceFlags.AUDITOR_DISCLOSABLE;
    await sns.setComplianceFlag(next);
  }

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 p-4 rounded-xl border",
        "border-gray/15 bg-muted/20",
        disabled && "opacity-70",
      )}
    >
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Auditor-disclosable</h3>
          {!sns.hasRegisteredSnsName && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
              No SNS registered
            </span>
          )}
          {sns.isRegistering && (
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Publishes a public signal on your `.btcpro.sol` record that you're
          OK receiving outgoing audit memos. Senders see an "Auditor-disclosable"
          chip when they enter your name. Your viewing keys are NOT shared by
          this flag — you still issue DelegatedViewKeys to specific auditors
          separately.
        </p>
        {sns.error && (
          <p className="text-xs text-error mt-2 font-mono break-all">{sns.error}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={handleToggle}
        className={cn(
          "shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors",
          enabled ? "bg-success" : "bg-muted",
          disabled && "cursor-not-allowed",
        )}
      >
        <span
          className={cn(
            "block w-5 h-5 rounded-full bg-background transition-transform",
            enabled ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}
