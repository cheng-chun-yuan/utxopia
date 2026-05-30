"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  KeyRound,
  Network,
  PackageCheck,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { SuiAuthPanel } from "@/components/sui/sui-auth-panel";
import { detectNetwork, getNetworkConfig, hrefWithChain, type NetworkId } from "@/lib/network-config";
import { cn } from "@/lib/utils";

type RpcState = "idle" | "loading" | "ok" | "error";
type SuiConfig = NonNullable<ReturnType<typeof getNetworkConfig>["sui"]>;

interface ObjectProbe {
  state: RpcState;
  version?: string;
  digest?: string;
  error?: string;
}

export function SuiDashboard() {
  const detected = detectNetwork();
  const networkId: NetworkId = detected === "sui-regtest" ? "sui-regtest" : "sui-testnet";
  const cfg = getNetworkConfig(networkId, { applyEnvOverrides: false });
  const sui = cfg.sui;

  if (!sui) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-32">
        <p className="text-gray">Sui configuration is missing.</p>
      </div>
    );
  }

  return <SuiContent networkId={networkId} sui={sui} />;
}

function SuiContent({ networkId, sui }: { networkId: NetworkId; sui: SuiConfig }) {
  const explorer = useMemo(() => makeExplorer(sui.explorerUrl), [sui.explorerUrl]);
  const [poolProbe, setPoolProbe] = useState<ObjectProbe>({ state: "idle" });
  const [capProbe, setCapProbe] = useState<ObjectProbe>({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setPoolProbe({ state: "loading" });
      setCapProbe({ state: "loading" });
      const [pool, cap] = await Promise.all([
        fetchObject(sui.rpcUrl, sui.pool.objectId),
        fetchObject(sui.rpcUrl, sui.redemptionCap.objectId),
      ]);
      if (cancelled) return;
      setPoolProbe(pool);
      setCapProbe(cap);
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [sui.pool.objectId, sui.redemptionCap.objectId, sui.rpcUrl]);

  return (
    <div className="w-full">
      <section className="relative overflow-hidden border-b border-gray/10 pt-28">
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute left-1/2 top-0 h-px w-[80vw] -translate-x-1/2 bg-gradient-to-r from-transparent via-sui/30 to-transparent" />
          <div className="absolute right-[-10%] top-24 h-72 w-72 rounded-full border border-sui/10" />
          <div className="absolute left-[-8%] bottom-[-20%] h-80 w-80 rounded-full border border-warning/10" />
        </div>

        <div className="relative mx-auto max-w-6xl px-6 pb-16">
          <div className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-sui/15 bg-sui/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-sui">
                <Network className="h-3.5 w-3.5" />
                {networkId === "sui-regtest" ? "Sui hybrid" : "Sui testnet"}
              </div>
              <div className="space-y-4">
                <h1 className="max-w-3xl text-[40px] font-semibold leading-[1.02] tracking-normal text-foreground sm:text-[56px]">
                  UTXOpia Move POC
                </h1>
                <p className="max-w-2xl text-base leading-7 text-gray">
                  Same app route, Sui network selected. This surface reads the Move package, shared object refs, native Groth16 proof path, and redemption policy events.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <ExplorerLink href={explorer.object(sui.packageId)} label="Open package" />
                {sui.lastTransact?.txDigest && (
                  <ExplorerLink href={explorer.tx(sui.lastTransact.txDigest)} label="Last JoinSplit" />
                )}
                {sui.lastRedemption?.completeTxDigest && (
                  <ExplorerLink href={explorer.tx(sui.lastRedemption.completeTxDigest)} label="Last redemption" />
                )}
              </div>
            </div>

            <div className="rounded-lg border border-gray/10 bg-muted/10 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Live refs</h2>
                  <p className="text-xs text-gray">Read from Sui RPC</p>
                </div>
                <StatusPill state={poolProbe.state === "ok" && capProbe.state === "ok" ? "ok" : poolProbe.state === "error" || capProbe.state === "error" ? "error" : "loading"} />
              </div>
              <div className="space-y-3">
                <ProbeRow label="Pool" probe={poolProbe} objectId={sui.pool.objectId} />
                <ProbeRow label="Redemption cap" probe={capProbe} objectId={sui.redemptionCap.objectId} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-4 md:grid-cols-3">
          <Capability icon={<PackageCheck className="h-5 w-5" />} title="Published package" status="live" detail={shorten(sui.packageId)} />
          <Capability icon={<ShieldCheck className="h-5 w-5" />} title="Groth16 verifier" status="live" detail={`${sui.vk?.joinsplit_1x1?.nPublic ?? 4} public inputs`} />
          <Capability icon={<KeyRound className="h-5 w-5" />} title="Ika policy" status="poc" detail="approval event" />
        </div>

        <div className="mt-10">
          <SuiAuthPanel />
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
          <section>
            <SectionTitle label="Objects" title="Shared Move state" />
            <div className="divide-y divide-gray/10 border-y border-gray/10">
              <ObjectRow label="Pool" value={sui.pool.objectId} href={explorer.object(sui.pool.objectId)} />
              {sui.btcDepositRegistry?.objectId && (
                <ObjectRow label="BTC deposits" value={sui.btcDepositRegistry.objectId} href={explorer.object(sui.btcDepositRegistry.objectId)} />
              )}
              <ObjectRow label="Nullifiers" value={sui.nullifierRegistry.objectId} href={explorer.object(sui.nullifierRegistry.objectId)} />
              <ObjectRow label="VK registry" value={sui.verifyingKeyRegistry.objectId} href={explorer.object(sui.verifyingKeyRegistry.objectId)} />
              <ObjectRow label="Redemptions" value={sui.redemptionQueue.objectId} href={explorer.object(sui.redemptionQueue.objectId)} />
            </div>
          </section>

          <section>
            <SectionTitle label="Recent POC" title="Last successful chain run" />
            <div className="grid gap-3">
              <TxRow icon={<ShieldCheck className="h-4 w-4" />} label="JoinSplit transact" digest={sui.lastTransact?.txDigest} href={sui.lastTransact?.txDigest ? explorer.tx(sui.lastTransact.txDigest) : undefined} meta={sui.lastTransact?.circuit} />
              <TxRow icon={<TerminalSquare className="h-4 w-4" />} label="Redemption request" digest={sui.lastRedemption?.requestTxDigest} href={sui.lastRedemption?.requestTxDigest ? explorer.tx(sui.lastRedemption.requestTxDigest) : undefined} meta={sui.lastRedemption?.redemptionId ? `id ${sui.lastRedemption.redemptionId}` : undefined} />
              <TxRow icon={<KeyRound className="h-4 w-4" />} label="Ika approval" digest={sui.lastRedemption?.ikaApprovalTxDigest} href={sui.lastRedemption?.ikaApprovalTxDigest ? explorer.tx(sui.lastRedemption.ikaApprovalTxDigest) : undefined} meta="policy event" />
              <TxRow icon={<CheckCircle2 className="h-4 w-4" />} label="Redemption complete" digest={sui.lastRedemption?.completeTxDigest} href={sui.lastRedemption?.completeTxDigest ? explorer.tx(sui.lastRedemption.completeTxDigest) : undefined} meta="success" />
            </div>
          </section>
        </div>

        <section className="mt-10 rounded-lg border border-warning/15 bg-warning/5 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-foreground">Production gap</h2>
              <p className="max-w-3xl text-sm leading-6 text-gray">
                The Sui package proves the Move object model, Sui native Groth16, and policy event surface. BTC SPV verification, Sui-side Ika dWallet package calls, and gross/net fee accounting still need to be promoted into the production bridge path.
              </p>
            </div>
            <Link href={hrefWithChain("/settings", networkId)} className="inline-flex shrink-0 items-center gap-2 rounded-md border border-gray/15 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-sui/30 hover:text-sui">
              Network settings
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </section>
      </section>
    </div>
  );
}

function SectionTitle({ label, title }: { label: string; title: string }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray">{label}</div>
      <h2 className="mt-1 text-xl font-semibold text-foreground">{title}</h2>
    </div>
  );
}

function ExplorerLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md bg-sui px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90">
      {label}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function StatusPill({ state }: { state: "ok" | "loading" | "error" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
        state === "ok" && "border-sui/20 bg-sui/10 text-sui",
        state === "loading" && "border-gray/15 bg-muted/20 text-gray",
        state === "error" && "border-error/20 bg-error/10 text-error",
      )}
    >
      {state === "ok" ? <CheckCircle2 className="h-3 w-3" /> : <CircleDashed className="h-3 w-3" />}
      {state}
    </span>
  );
}

function ProbeRow({ label, probe, objectId }: { label: string; probe: ObjectProbe; objectId: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 text-xs">
      <span className="text-gray">{label}</span>
      <div className="min-w-0">
        <div className="break-all font-mono text-foreground/85">{shorten(objectId, 14, 10)}</div>
        <div className="mt-1 text-[11px] text-gray">
          {probe.state === "ok" && `v${probe.version} | ${shorten(probe.digest ?? "", 8, 8)}`}
          {probe.state === "loading" && "checking"}
          {probe.state === "error" && (probe.error ?? "unreachable")}
          {probe.state === "idle" && "idle"}
        </div>
      </div>
    </div>
  );
}

function Capability({ icon, title, status, detail }: { icon: React.ReactNode; title: string; status: "live" | "poc"; detail: string }) {
  return (
    <div className="rounded-lg border border-gray/10 bg-muted/10 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-sui/15 bg-sui/5 text-sui">{icon}</div>
        <span className={cn("rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]", status === "live" ? "border-sui/20 bg-sui/10 text-sui" : "border-warning/20 bg-warning/10 text-warning")}>
          {status}
        </span>
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 break-all font-mono text-xs text-gray">{detail}</p>
    </div>
  );
}

function ObjectRow({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="grid grid-cols-[120px_1fr_auto] items-center gap-3 py-3 text-sm transition-colors hover:bg-muted/20">
      <span className="text-gray">{label}</span>
      <span className="min-w-0 break-all font-mono text-xs text-foreground/85">{value}</span>
      <ExternalLink className="h-3.5 w-3.5 text-gray" />
    </a>
  );
}

function TxRow({ icon, label, digest, href, meta }: { icon: React.ReactNode; label: string; digest?: string; href?: string; meta?: string }) {
  const content = (
    <>
      <div className="flex h-8 w-8 items-center justify-center rounded-md border border-gray/10 bg-background/40 text-sui">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{label}</span>
          {meta && <span className="text-[10px] uppercase tracking-[0.12em] text-gray">{meta}</span>}
        </div>
        <div className="mt-1 break-all font-mono text-xs text-gray">{digest ?? "not recorded"}</div>
      </div>
      {href && <ExternalLink className="h-3.5 w-3.5 text-gray" />}
    </>
  );

  if (!href) return <div className="flex items-center gap-3 rounded-lg border border-gray/10 bg-muted/10 p-4">{content}</div>;

  return (
    <a href={href} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border border-gray/10 bg-muted/10 p-4 transition-colors hover:border-sui/25 hover:bg-sui/5">
      {content}
    </a>
  );
}

function makeExplorer(base: string) {
  const clean = base.replace(/\/$/, "");
  return {
    object: (id: string) => `${clean}/object/${id}?network=testnet`,
    tx: (digest: string) => `${clean}/txblock/${digest}?network=testnet`,
  };
}

function shorten(value: string, start = 10, end = 8): string {
  if (!value) return "";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

async function fetchObject(rpcUrl: string, objectId: string): Promise<ObjectProbe> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_getObject",
        params: [objectId, { showContent: false }],
      }),
    });
    if (!response.ok) return { state: "error", error: `HTTP ${response.status}` };
    const body = await response.json() as {
      result?: { data?: { version?: string | number; digest?: string } };
      error?: { message?: string };
    };
    if (body.error) return { state: "error", error: body.error.message ?? "RPC error" };
    const data = body.result?.data;
    return {
      state: data ? "ok" : "error",
      version: data?.version == null ? undefined : String(data.version),
      digest: data?.digest,
      error: data ? undefined : "missing",
    };
  } catch (error) {
    return { state: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
