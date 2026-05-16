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

/**
 * Settings — grouped into three semantic sections (Network · Identity ·
 * Sending). Each group is a flat list of rows separated by hairlines —
 * no card-on-card wrappers, no repeated borders. Color is applied with
 * intent: privacy green for active/enabled signals, neutral gray for
 * everything else.
 */
export function PreferencesForm() {
  const { isAdvanced } = useUiMode();
  // Phase 1: read-only.
  const advancedDisabled = true;

  return (
    <div className="space-y-12">
      <Section label="Network">
        <NetworkSelector />
      </Section>

      <Section
        label="Identity"
        hint="What senders see when they enter your .btcpro.sol name."
      >
        <AuditorDisclosableRow />
        <AuditorPubkeyRow />
      </Section>

      <Section label="Sending">
        <ToggleRow
          title="Advanced send"
          chip={advancedDisabled ? "Coming soon" : undefined}
          enabled={isAdvanced}
          disabled={advancedDisabled}
          description={
            <>
              Multi-output sends (batch to multiple recipients in one ZK
              proof), custom Bitcoin fee rate, and manual coin selection.
            </>
          }
        />
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Layout primitives                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Semantic settings group. Renders a small uppercase eyebrow label, an
 * optional one-line hint, then its children as a flat hairline-separated
 * list. Children should be Row primitives, not cards.
 */
function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[10px] uppercase tracking-[0.18em] text-gray font-semibold">
          {label}
        </h2>
        {hint && (
          <span className="text-[11px] text-gray/70 truncate">{hint}</span>
        )}
      </div>
      <div className="divide-y divide-gray/10 border-y border-gray/10">
        {children}
      </div>
    </section>
  );
}

/**
 * Single row: title + status chips + info disclosure + control. The
 * description lives inside <InfoTip> so the visible row stays one line.
 */
function ToggleRow({
  title,
  chip,
  description,
  enabled,
  disabled,
  onToggle,
  activeAccent = "privacy",
}: {
  title: string;
  chip?: string;
  description: React.ReactNode;
  enabled: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  activeAccent?: "privacy" | "success";
}) {
  return (
    <div className={cn("py-4 px-1", disabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {chip && (
            <span className="text-[10px] uppercase tracking-wide text-gray bg-muted/40 px-1.5 py-0.5 rounded">
              {chip}
            </span>
          )}
          <InfoTip label={`About ${title}`}>{description}</InfoTip>
        </div>
        <Toggle
          enabled={enabled}
          disabled={disabled}
          onToggle={onToggle}
          activeAccent={activeAccent}
        />
      </div>
    </div>
  );
}

function Toggle({
  enabled,
  disabled,
  onToggle,
  activeAccent = "privacy",
}: {
  enabled: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  activeAccent?: "privacy" | "success";
}) {
  const activeColor =
    activeAccent === "privacy" ? "bg-privacy" : "bg-success";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors duration-200",
        enabled ? activeColor : "bg-muted",
        disabled && "cursor-not-allowed",
      )}
    >
      <span
        className={cn(
          "block w-5 h-5 rounded-full bg-background transition-transform duration-200 ease-out",
          enabled ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Identity rows                                                             */
/* -------------------------------------------------------------------------- */

/**
 * AUDITOR_DISCLOSABLE flag — surfaces on the user's .btcpro.sol record
 * as a public signal that they accept outgoing audit memos. Doesn't
 * leak any key material; that still happens via DelegatedViewKey.
 */
function AuditorDisclosableRow() {
  const sns = useSnsName();
  const enabled =
    (sns.complianceFlags & SnsComplianceFlags.AUDITOR_DISCLOSABLE) !== 0;
  const disabled =
    !sns.hasRegisteredSnsName || sns.isRegistering || sns.isLoading;

  async function handleToggle() {
    if (disabled) return;
    const next = enabled
      ? sns.complianceFlags & ~SnsComplianceFlags.AUDITOR_DISCLOSABLE
      : sns.complianceFlags | SnsComplianceFlags.AUDITOR_DISCLOSABLE;
    await sns.setComplianceFlag(next);
  }

  return (
    <div className={cn("py-4 px-1", disabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="text-sm font-medium text-foreground">
            Auditor-disclosable
          </span>
          {!sns.hasRegisteredSnsName && (
            <span className="text-[10px] uppercase tracking-wide text-gray bg-muted/40 px-1.5 py-0.5 rounded">
              No SNS
            </span>
          )}
          {sns.isRegistering && (
            <Loader2 className="w-3 h-3 animate-spin text-gray" />
          )}
          <InfoTip label="About Auditor-disclosable">
            Publishes a public signal on your `.btcpro.sol` record that
            you're OK receiving outgoing audit memos. Senders see an
            "Auditor-disclosable" chip when they enter your name. Your
            viewing keys are <strong>not</strong> shared by this flag —
            you still issue DelegatedViewKeys to specific auditors
            separately.
          </InfoTip>
        </div>
        <Toggle enabled={enabled} disabled={disabled} onToggle={handleToggle} />
      </div>
      {sns.error && (
        <p className="text-xs text-error mt-2 font-mono break-all">
          {sns.error}
        </p>
      )}
    </div>
  );
}

/**
 * Optional pubkey hint that pairs with the AUDITOR_DISCLOSABLE flag.
 * Visually nested under it via a subtle indent + connector rail.
 */
function AuditorPubkeyRow() {
  const sns = useSnsName();
  const currentBase58 = sns.auditorPubkey
    ? new PublicKey(sns.auditorPubkey).toBase58()
    : "";
  const [value, setValue] = useState(currentBase58);
  const [parseError, setParseError] = useState<string | null>(null);
  const disabled =
    !sns.hasRegisteredSnsName || sns.isRegistering || sns.isLoading;
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
    <div className={cn("py-4 px-1", disabled && "opacity-60")}>
      {/* Nested under Auditor-disclosable — indent + soft rail */}
      <div className="pl-4 border-l border-gray/15">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">
            Designated auditor
          </span>
          <span className="text-[10px] uppercase tracking-wide text-gray">
            optional
          </span>
          <InfoTip label="About Designated auditor">
            Public Solana pubkey of the auditor you've issued a
            DelegatedViewKey to (off-chain). Senders see this in the
            badge when they enter your name. Leave blank to publish only
            the flag bit.
          </InfoTip>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled}
            placeholder="Base58 Solana pubkey"
            className={cn(
              "flex-1 min-w-0 px-3 py-1.5 rounded-md bg-muted/40 border border-gray/10",
              "text-[12px] font-mono outline-none",
              "focus:border-privacy/40 focus:bg-muted/60 transition-colors",
              disabled && "cursor-not-allowed",
            )}
          />
          {dirty && (
            <button
              type="button"
              onClick={() => {
                setValue(currentBase58);
                setParseError(null);
              }}
              disabled={disabled}
              className="text-[11px] text-gray hover:text-foreground transition-colors px-2"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={disabled || !dirty}
            className={cn(
              "shrink-0 px-3 py-1.5 text-[11px] font-medium rounded-md transition-all",
              dirty && !disabled
                ? "bg-privacy text-background hover:opacity-90"
                : "bg-muted/40 text-gray cursor-not-allowed",
            )}
          >
            {value.trim() === "" ? "Clear" : "Save"}
          </button>
        </div>

        {parseError && (
          <p className="mt-1.5 text-[11px] text-error font-mono">
            {parseError}
          </p>
        )}
      </div>
    </div>
  );
}
