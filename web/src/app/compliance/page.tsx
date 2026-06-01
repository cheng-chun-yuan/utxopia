"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  X,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  KeyRound,
  Eye,
  Send,
} from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { useSnsName } from "@/hooks/use-sns-name";
import { SnsComplianceFlags, type DelegationRecord } from "@utxopia/sdk";
import { cn } from "@/lib/utils";

/**
 * Compliance posture dashboard. Aggregates everything the user has (or
 * hasn't) opted into across the four-phase compliance pillar so they can
 * see their auditor surface area at a glance.
 *
 * Read-only — fixes live on the existing Settings, /audit/issued, and
 * CLI surfaces. This page is the "you are here" map.
 */

const DELEGATIONS_STORAGE_KEY = "utxopia.delegations.v1";

type RowStatus = "ok" | "warn" | "off";

interface CheckRowProps {
  icon: React.ReactNode;
  title: string;
  desc: string;
  status: RowStatus;
  statusLabel: string;
  detail?: React.ReactNode;
  ctaLabel?: string;
  ctaHref?: string;
  ctaExternal?: boolean;
}

const STATUS_STYLES: Record<RowStatus, { ring: string; bg: string; icon: React.ReactNode; pill: string }> = {
  ok: {
    ring: "border-success/30",
    bg: "bg-success/5",
    icon: <Check className="w-3.5 h-3.5 text-success" />,
    pill: "text-success bg-success/10 border-success/20",
  },
  warn: {
    ring: "border-warning/30",
    bg: "bg-warning/5",
    icon: <AlertCircle className="w-3.5 h-3.5 text-warning" />,
    pill: "text-warning bg-warning/10 border-warning/20",
  },
  off: {
    ring: "border-gray/20",
    bg: "bg-muted/10",
    icon: <X className="w-3.5 h-3.5 text-gray" />,
    pill: "text-gray bg-gray/10 border-gray/20",
  },
};

function CheckRow({
  icon, title, desc, status, statusLabel, detail, ctaLabel, ctaHref, ctaExternal,
}: CheckRowProps) {
  const s = STATUS_STYLES[status];
  return (
    <div
      className={cn(
        "rounded-xl border p-5 flex items-start justify-between gap-4",
        s.ring,
        s.bg,
      )}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className="p-2 rounded-lg border border-gray/10 bg-background/50 shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <span className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wider",
              s.pill,
            )}>
              {s.icon}
              {statusLabel}
            </span>
          </div>
          <p className="text-xs text-gray font-light leading-relaxed mt-1 break-words">{desc}</p>
          {detail && (
            <div className="mt-2 text-[11px] font-mono text-foreground/70 break-all">{detail}</div>
          )}
        </div>
      </div>
      {ctaLabel && ctaHref && (
        <Link
          href={ctaHref}
          {...(ctaExternal ? { target: "_blank", rel: "noreferrer" } : {})}
          className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray/15 text-[11px] font-medium hover:bg-muted/30 hover:border-privacy/30 transition-colors"
        >
          {ctaLabel}
          {ctaExternal ? <ExternalLink className="w-3 h-3" /> : null}
        </Link>
      )}
    </div>
  );
}

export default function CompliancePage() {
  const sns = useSnsName();

  // Read delegations the user has issued (stored locally by the
  // /audit/issued page).
  const delegations = useMemo(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(DELEGATIONS_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as DelegationRecord[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, []);

  const auditorBase58 = useMemo(() => {
    if (!sns.auditorPubkey) return null;
    try {
      return new PublicKey(sns.auditorPubkey).toBase58();
    } catch {
      return null;
    }
  }, [sns.auditorPubkey]);

  const isAuditorDisclosable =
    (sns.complianceFlags & SnsComplianceFlags.AUDITOR_DISCLOSABLE) !== 0;

  // Aggregate score: how many of the four signals are live?
  const checks = [
    sns.hasRegisteredSnsName,
    isAuditorDisclosable,
    auditorBase58 !== null,
    delegations.length > 0,
  ];
  const liveCount = checks.filter(Boolean).length;

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay">
      <SiteHeader />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-28 sm:pt-32 pb-12">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <Link
            href="/vault"
            className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to vault
          </Link>
          <span className="text-caption text-gray font-mono">
            {liveCount}/4 signals live
          </span>
        </div>

        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray/15 bg-muted/20 mb-4">
            <ShieldCheck className="w-3.5 h-3.5 text-gray-light" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-gray">
              Compliance posture
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground mb-2">
            Your auditor surface area
          </h1>
          <p className="text-sm text-gray font-light max-w-2xl leading-relaxed">
            Every signal you publish or share gives auditors more visibility
            into your shielded activity — and you control each independently.
            Nothing here is set by default; you opt into each layer when you
            want it.
          </p>
        </div>

        <div className="space-y-3">
          {/* 1. SNS registration */}
          <CheckRow
            icon={<KeyRound className="w-4 h-4 text-gray-light" />}
            title="SNS subdomain registered"
            desc="Senders can resolve a memorable name (e.g. alice.utxopia.sol) to your stealth address. Without this, only people who copy-paste your `utxo:` string can pay you."
            status={sns.hasRegisteredSnsName ? "ok" : "off"}
            statusLabel={sns.hasRegisteredSnsName ? "Registered" : "Not set"}
            detail={sns.registeredSnsName ? `${sns.registeredSnsName}.utxopia.sol` : undefined}
            ctaLabel={sns.hasRegisteredSnsName ? "Manage" : "Register"}
            ctaHref="/settings"
          />

          {/* 2. Auditor-disclosable bit */}
          <CheckRow
            icon={<Eye className="w-4 h-4 text-gray-light" />}
            title="Auditor-disclosable bit"
            desc="Public signal on your SNS record that you're OK receiving outgoing audit memos. Senders see an 'auditor-disclosable' chip when they enter your name."
            status={isAuditorDisclosable ? "ok" : "off"}
            statusLabel={isAuditorDisclosable ? "On" : "Off"}
            ctaLabel="Toggle"
            ctaHref="/settings"
          />

          {/* 3. Auditor pubkey hint */}
          <CheckRow
            icon={<Send className="w-4 h-4 text-gray-light" />}
            title="Designated auditor pubkey"
            desc="Optional 32-byte Solana pubkey on your SNS record, telling senders who you've granted read-only access to. Just a hint — the actual viewing key share is still out-of-band."
            status={auditorBase58 ? "ok" : isAuditorDisclosable ? "warn" : "off"}
            statusLabel={
              auditorBase58
                ? "Published"
                : isAuditorDisclosable
                  ? "Bit set, pubkey missing"
                  : "Not set"
            }
            detail={auditorBase58 ?? undefined}
            ctaLabel={auditorBase58 ? "Change" : "Set"}
            ctaHref="/settings"
          />

          {/* 4. Delegated view keys issued */}
          <CheckRow
            icon={<ShieldCheck className="w-4 h-4 text-gray-light" />}
            title="Delegated view keys issued"
            desc="Encrypted, slot-scoped viewing keys you've handed to specific auditors. Each one lets the recipient scan your IN (+ OUT, once sender memos populate) records over the chosen slot range — never spend."
            status={delegations.length > 0 ? "ok" : "off"}
            statusLabel={
              delegations.length === 0
                ? "None issued"
                : delegations.length === 1
                  ? "1 issued"
                  : `${delegations.length} issued`
            }
            detail={
              delegations.length > 0
                ? delegations
                    .slice(0, 3)
                    .map((d) => `${d.label ?? "(unlabeled)"} · ${d.fingerprint?.slice(0, 8) ?? "?"}`)
                    .join("  ·  ") + (delegations.length > 3 ? `  · +${delegations.length - 3} more` : "")
                : undefined
            }
            ctaLabel={delegations.length > 0 ? "Manage" : "Issue"}
            ctaHref="/audit/issued"
          />
        </div>

        {/* What's missing — contextual nudges */}
        {liveCount < 4 && (
          <div className="mt-8 p-4 rounded-xl border border-gray/15 bg-muted/10">
            <h3 className="text-sm font-medium mb-2">Next step</h3>
            <p className="text-xs text-gray leading-relaxed">
              {!sns.hasRegisteredSnsName
                ? "Register an SNS subdomain first — every other signal hangs off it. Head to Settings."
                : !isAuditorDisclosable
                  ? "Flip the auditor-disclosable bit if you want senders to know you're OK receiving audit memos. Head to Settings."
                  : !auditorBase58
                    ? "You've published the bit but not the auditor pubkey. Either set one in Settings, or leave it blank (and senders treat it as a generic disclosability signal)."
                    : "Issue at least one DelegatedViewKey so an auditor can actually scan your activity. Head to /audit/issued."}
            </p>
          </div>
        )}

        {/* Honesty: what auditors *can't* see */}
        <div className="mt-8 p-4 rounded-xl border border-gray/10 bg-muted/5">
          <h3 className="text-sm font-medium mb-2 text-gray-light">
            What auditors with your viewing key still can&apos;t see
          </h3>
          <ul className="text-xs text-gray space-y-1 leading-relaxed list-disc pl-4">
            <li>Your spending key — they read but never sign on your behalf.</li>
            <li>Your funds — issuing a viewing key doesn&apos;t move anything.</li>
            <li>
              Outgoing flows from before sender-memos shipped, or transfers
              with sender memos disabled (NEXT_PUBLIC_DISABLE_SENDER_MEMOS=1).
            </li>
            <li>Activity outside the slot range you scoped the delegation to.</li>
          </ul>
        </div>
      </div>

      <SiteFooter />
    </main>
  );
}
