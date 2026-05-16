"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { useUiMode } from "@/hooks/use-ui-mode";
import { useSnsName } from "@/hooks/use-sns-name";
import { cn } from "@/lib/utils";
import { NetworkSelector } from "@/components/settings/network-selector";
import { InfoTip } from "@/components/ui/info-tip";
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
          "p-4 rounded-xl border border-gray/15 bg-muted/20",
          advancedDisabled && "opacity-70",
        )}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-medium">Advanced send</h3>
            {advancedDisabled && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                Coming soon
              </span>
            )}
            <InfoTip label="About Advanced send">
              Multi-output sends (batch to multiple recipients in one ZK proof),
              custom Bitcoin fee rate, and manual coin selection.
            </InfoTip>
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

      <AuditorDisclosableToggle />
      <AuditorPubkeyField />
    </div>
  );
}

/**
 * Pubkey hint for the recipient's designated auditor. Optional — only
 * meaningful when AUDITOR_DISCLOSABLE is set; the pubkey itself is just
 * a public Solana address (no secret material), telling senders who the
 * recipient discloses to. Distribution of the actual DelegatedViewKey
 * remains out-of-band.
 */
function AuditorPubkeyField() {
  const sns = useSnsName();
  const currentBase58 = sns.auditorPubkey
    ? new PublicKey(sns.auditorPubkey).toBase58()
    : "";
  const [value, setValue] = useState(currentBase58);
  const [parseError, setParseError] = useState<string | null>(null);

  const disabled = !sns.hasRegisteredSnsName || sns.isRegistering || sns.isLoading;
  const dirty = value.trim() !== currentBase58;

  async function handleSave() {
    setParseError(null);
    const trimmed = value.trim();
    if (trimmed === "") {
      await sns.setAuditorPubkey(null);
      return;
    }
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(trimmed);
    } catch {
      setParseError("Must be a base58 Solana pubkey (32 bytes).");
      return;
    }
    await sns.setAuditorPubkey(pubkey);
  }

  return (
    <div
      className={cn(
        "p-4 rounded-xl border border-gray/15 bg-muted/20 space-y-3",
        disabled && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Designated auditor (optional)</h3>
        {sns.isRegistering && (
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
        )}
        <InfoTip label="About Designated auditor">
          Public Solana pubkey of the auditor you've issued a
          DelegatedViewKey to (off-chain). Senders see this in the badge
          when they enter your name, so they know who you've granted
          read-only access to. Leave blank to publish only the flag bit.
        </InfoTip>
      </div>

      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        placeholder="Base58 Solana pubkey (e.g. 9WzDXwB…WWM)"
        className={cn(
          "w-full px-3 py-2 rounded-lg bg-background border border-gray/15",
          "text-[11px] font-mono outline-none focus:border-privacy/40",
          disabled && "cursor-not-allowed",
        )}
      />

      {parseError && (
        <p className="text-xs text-error font-mono">{parseError}</p>
      )}

      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <button
            type="button"
            onClick={() => { setValue(currentBase58); setParseError(null); }}
            disabled={disabled}
            className="px-3 py-1.5 text-xs rounded-lg border border-gray/15 hover:bg-muted/30"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={disabled || !dirty}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg",
            "bg-privacy text-background hover:opacity-90",
            (disabled || !dirty) && "opacity-50 cursor-not-allowed",
          )}
        >
          {value.trim() === "" ? "Clear" : "Save"}
        </button>
      </div>
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
        "p-4 rounded-xl border border-gray/15 bg-muted/20",
        disabled && "opacity-70",
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <h3 className="text-sm font-medium">Auditor-disclosable</h3>
          {!sns.hasRegisteredSnsName && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
              No SNS registered
            </span>
          )}
          {sns.isRegistering && (
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          )}
          <InfoTip label="About Auditor-disclosable">
            Publishes a public signal on your `.btcpro.sol` record that you're
            OK receiving outgoing audit memos. Senders see an "Auditor-disclosable"
            chip when they enter your name. Your viewing keys are NOT shared by
            this flag — you still issue DelegatedViewKeys to specific auditors
            separately.
          </InfoTip>
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
      {sns.error && (
        <p className="text-xs text-error mt-2 font-mono break-all">{sns.error}</p>
      )}
    </div>
  );
}
