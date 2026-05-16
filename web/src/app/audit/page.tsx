"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  AnnouncementClient,
  auditScan,
  auditRecordsToCsv,
  deserializeDelegatedViewKey,
  fingerprintDelegatedKey,
  type AuditRecord,
  type AuditScanAnnouncement,
  type AuditScanSummary,
  type DelegatedViewKey,
} from "@utxopia/sdk";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { InfoTip } from "@/components/ui/info-tip";
import { getBackendUrl } from "@/lib/api/constants";
import { getNetworkConfig } from "@/lib/network-config";

const ZKBTC_TOKEN_ID = BigInt(0x7a627463);

type Phase = "idle" | "decrypting" | "scanning" | "done" | "error";

export default function AuditPage() {
  const [keyJson, setKeyJson] = useState<string | null>(null);
  const [keyFileName, setKeyFileName] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [delegated, setDelegated] = useState<DelegatedViewKey | null>(null);
  const [summary, setSummary] = useState<AuditScanSummary | null>(null);
  const [overrideFromSlot, setOverrideFromSlot] = useState("");
  const [overrideToSlot, setOverrideToSlot] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onFile = useCallback(async (file: File) => {
    setKeyFileName(file.name);
    setKeyJson(await file.text());
    setDelegated(null);
    setSummary(null);
    setError(null);
  }, []);

  const onScan = useCallback(async () => {
    if (!keyJson) return;
    setError(null);
    setSummary(null);
    setPhase("decrypting");
    try {
      const key = await deserializeDelegatedViewKey(keyJson, password);
      setDelegated(key);
      setPhase("scanning");

      const cfg = getNetworkConfig();
      const client = new AnnouncementClient({
        backendUrl: getBackendUrl(),
        solanaRpcUrl: cfg.solana.rpcUrl,
        programId: cfg.solana.utxopiaProgramId,
      });
      const raw = await client.fetchAll();
      client.close();

      const annotated: AuditScanAnnouncement[] = raw.map((a) => ({ ...a }));
      const fromSlot = overrideFromSlot ? Number(overrideFromSlot) : undefined;
      const toSlot = overrideToSlot ? Number(overrideToSlot) : undefined;

      const result = await auditScan(key, annotated, {
        tokenIds: [ZKBTC_TOKEN_ID],
        fromSlot,
        toSlot,
      });
      setSummary(result);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [keyJson, password, overrideFromSlot, overrideToSlot]);

  const downloadCsv = useCallback(() => {
    if (!summary) return;
    const csv = auditRecordsToCsv(summary.records);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `utxopia-audit-${fingerprintDelegatedKey(delegated!)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [summary, delegated]);

  const totalsByToken = useMemo(() => {
    if (!summary) return new Map<string, bigint>();
    const out = new Map<string, bigint>();
    for (const r of summary.records) {
      const k = r.tokenId.toString();
      out.set(k, (out.get(k) ?? 0n) + r.amount);
    }
    return out;
  }, [summary]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-black to-zinc-950 text-white">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 py-12">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Audit mode</h1>
          <InfoTip label="About Audit mode">
            Decrypt a delegated viewing key in your browser and produce a CSV report.
            Nothing leaves your device — the key is decrypted in-browser, announcements
            are fetched directly from the public backend.
          </InfoTip>
        </div>

        <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
          <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">
            1. Load delegated key
          </h2>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) await onFile(f);
            }}
            className="mt-3 cursor-pointer rounded-lg border-2 border-dashed border-zinc-700 px-6 py-8 text-center text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
          >
            {keyFileName ? (
              <>
                <div className="text-zinc-200">{keyFileName}</div>
                <div className="mt-1 text-xs text-zinc-500">click or drop to replace</div>
              </>
            ) : (
              <>
                <div>Drop encrypted key JSON here</div>
                <div className="mt-1 text-xs text-zinc-500">or click to browse</div>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await onFile(f);
              }}
            />
          </div>
        </section>

        <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
          <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">
            2. Password & optional scope override
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-400 sm:col-span-3">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              From slot (override)
              <input
                inputMode="numeric"
                value={overrideFromSlot}
                onChange={(e) => setOverrideFromSlot(e.target.value.replace(/[^\d]/g, ""))}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                placeholder="key default"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              To slot (override)
              <input
                inputMode="numeric"
                value={overrideToSlot}
                onChange={(e) => setOverrideToSlot(e.target.value.replace(/[^\d]/g, ""))}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                placeholder="key default"
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={!keyJson || !password || phase === "decrypting" || phase === "scanning"}
                onClick={onScan}
                className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {phase === "decrypting"
                  ? "Decrypting…"
                  : phase === "scanning"
                    ? "Scanning…"
                    : "Run audit"}
              </button>
            </div>
          </div>
        </section>

        {error && (
          <div className="mt-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
            {error}
          </div>
        )}

        {delegated && (
          <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
            <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">
              Key info
            </h2>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <Row label="Fingerprint" value={fingerprintDelegatedKey(delegated)} mono />
              <Row label="Label" value={delegated.label ?? "—"} />
              <Row
                label="Slot range"
                value={`[${delegated.fromSlot ?? "∗"}, ${delegated.toSlot ?? "∗"}]`}
              />
              <Row
                label="Expires"
                value={
                  delegated.expiresAt
                    ? new Date(delegated.expiresAt).toISOString()
                    : "never"
                }
              />
            </dl>
          </section>
        )}

        {summary && (
          <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-sm font-medium uppercase tracking-wider text-zinc-400">
                Report
              </h2>
              <button
                type="button"
                onClick={downloadCsv}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500"
              >
                Download CSV
              </button>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-400">
              <span>matched: <span className="text-zinc-100">{summary.records.length}</span></span>
              <span>out-of-range: <span className="text-zinc-100">{summary.outOfRangeSkipped}</span></span>
              <span>unscoped: <span className="text-zinc-100">{summary.unscopedSkipped}</span></span>
              <span>not-for-viewer: <span className="text-zinc-100">{summary.notForViewerSkipped}</span></span>
            </div>

            {totalsByToken.size > 0 && (
              <div className="mt-3 text-xs text-zinc-400">
                Totals per token:{" "}
                {[...totalsByToken.entries()].map(([t, sum]) => (
                  <span key={t} className="ml-2 inline-block rounded bg-zinc-800 px-2 py-0.5 text-zinc-200">
                    {t}: {sum.toString()}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="px-2 py-1">Slot</th>
                    <th className="px-2 py-1">Time</th>
                    <th className="px-2 py-1">Leaf</th>
                    <th className="px-2 py-1">Dir</th>
                    <th className="px-2 py-1">Type</th>
                    <th className="px-2 py-1">Token</th>
                    <th className="px-2 py-1">Amount</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[11px] text-zinc-300">
                  {summary.records.map((r: AuditRecord) => (
                    <tr key={`${r.leafIndex}-${r.commitmentHex}`} className="border-t border-zinc-800/60">
                      <td className="px-2 py-1">{r.slot}</td>
                      <td className="px-2 py-1">
                        {r.blockTime > 0 ? new Date(r.blockTime * 1000).toISOString() : "—"}
                      </td>
                      <td className="px-2 py-1">{r.leafIndex}</td>
                      <td className="px-2 py-1">{r.direction}</td>
                      <td className="px-2 py-1">{r.announcementType === 0 ? "deposit" : "transfer"}</td>
                      <td className="px-2 py-1">{r.tokenId.toString()}</td>
                      <td className="px-2 py-1">{r.amount.toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {summary.records.length === 0 && (
                <div className="py-6 text-center text-xs text-zinc-500">
                  No records — either the key has nothing in scope, or no announcements
                  matched within the slot range.
                </div>
              )}
            </div>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-zinc-800/60 pb-1">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={mono ? "font-mono text-xs text-zinc-200" : "text-zinc-200"}>{value}</dd>
    </div>
  );
}
