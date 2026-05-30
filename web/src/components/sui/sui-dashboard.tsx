"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import {
  ArrowDownToLine,
  ChevronDown,
  ExternalLink,
  History,
  Send,
  Settings,
  Shield,
  X,
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

  return <SuiVaultCard networkId={networkId} sui={sui} />;
}

function SuiVaultCard({ networkId, sui }: { networkId: NetworkId; sui: SuiConfig }) {
  const explorer = useMemo(() => makeExplorer(sui.explorerUrl), [sui.explorerUrl]);
  const [poolProbe, setPoolProbe] = useState<ObjectProbe>({ state: "idle" });
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setPoolProbe({ state: "loading" });
      const pool = await fetchObject(sui.rpcUrl, sui.pool.objectId);
      if (!cancelled) setPoolProbe(pool);
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [sui.pool.objectId, sui.rpcUrl]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (hash.get("id_token") || hash.get("error")) setAuthOpen(true);
  }, []);

  return (
    <div className="flex-1 flex flex-col items-center pt-24 pb-8 px-4">
      <motion.div
        className={cn(
          "bg-card border border-solid border-sui/20 p-4 shadow-[0_0_40px_rgba(111,188,240,0.08)] sm:p-8",
          "w-[680px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "relative z-10",
        )}
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="text-body2-semibold text-foreground">Wallet</span>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-sui/20 bg-sui/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sui">
              {networkId === "sui-regtest" ? "Sui Hybrid" : "Sui Testnet"}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center pb-5 pt-3 text-center">
          <h1 className="mb-1 text-[22px] font-bold text-foreground">Your Wallet</h1>
          <p className="mb-6 text-caption text-gray/60">Private Sui test vault.</p>
          <button
            type="button"
            onClick={() => setAuthOpen(true)}
            className="mb-6 inline-flex items-center gap-2 rounded-full bg-sui px-7 py-3 text-body2 font-semibold text-background transition-opacity hover:opacity-90 active:scale-95"
          >
            <Shield className="h-4 w-4" />
            Get Started
          </button>

          <div className="flex items-center justify-center gap-5 sm:gap-8">
            <VaultAction href={hrefWithChain("/vault/deposit", networkId)} icon={<ArrowDownToLine className="h-5 w-5" />} label="Deposit" />
            <VaultAction href={hrefWithChain("/send", networkId)} icon={<Send className="h-5 w-5" />} label="Send" />
            <VaultAction href={hrefWithChain("/vault/activity", networkId)} icon={<History className="h-5 w-5" />} label="Activity" />
          </div>
        </div>

        <details className="group mt-4 rounded-[10px] bg-muted/20 px-3 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] text-gray/60">
            <span>Details</span>
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          </summary>

          <div className="mt-3 space-y-3 border-t border-gray/10 pt-3">
            <TechRow label="Status" value={poolProbe.state} />
            <TechRow label="Package" value={shorten(sui.packageId)} href={explorer.object(sui.packageId)} />
            <TechRow label="Pool" value={shorten(sui.pool.objectId)} href={explorer.object(sui.pool.objectId)} />
            {sui.btcDepositRegistry?.objectId && (
              <TechRow label="BTC deposits" value={shorten(sui.btcDepositRegistry.objectId)} href={explorer.object(sui.btcDepositRegistry.objectId)} />
            )}
            {sui.lastTransact?.txDigest && (
              <TechRow label="Last JoinSplit" value={shorten(sui.lastTransact.txDigest)} href={explorer.tx(sui.lastTransact.txDigest)} />
            )}
            {sui.lastRedemption?.completeTxDigest && (
              <TechRow label="Last withdrawal" value={shorten(sui.lastRedemption.completeTxDigest)} href={explorer.tx(sui.lastRedemption.completeTxDigest)} />
            )}
            <Link
              href={hrefWithChain("/settings", networkId)}
              className="inline-flex items-center gap-1 text-[11px] text-sui hover:text-sui/80"
            >
              <Settings className="h-3 w-3" />
              Network settings
            </Link>
          </div>
        </details>

        <div className="flex items-center justify-center gap-2 pt-4">
          <span className="h-1.5 w-1.5 rounded-full bg-sui" />
          <span className="text-[11px] text-gray/40">
            Bitcoin {networkId === "sui-regtest" ? "Regtest" : "Testnet4"} · Sui Testnet
          </span>
        </div>
      </motion.div>

      <SuiAuthModal open={authOpen} onOpenChange={setAuthOpen} />
    </div>
  );
}

function SuiAuthModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md animate-in fade-in-0 duration-200" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-[520px] -translate-x-1/2 -translate-y-1/2",
            "rounded-[20px] border border-gray/20 bg-card/95 p-5 shadow-[0_0_80px_rgba(111,188,240,0.08)] backdrop-blur-xl",
            "animate-in fade-in-0 zoom-in-95 duration-200 focus:outline-none",
          )}
          aria-describedby="sui-auth-description"
        >
          <Dialog.Close asChild>
            <button
              className="absolute right-4 top-4 rounded-full bg-gray/10 p-1.5 text-gray transition-colors hover:bg-gray/20"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>

          <div className="mb-4 text-center">
            <div className="mb-3 inline-flex rounded-full border border-sui/20 bg-sui/10 p-3">
              <Shield className="h-6 w-6 text-sui" />
            </div>
            <Dialog.Title className="text-[20px] font-bold text-foreground">
              Sign In
            </Dialog.Title>
            <Dialog.Description id="sui-auth-description" className="mt-1 text-body2 text-gray">
              Choose how to access your Sui vault.
            </Dialog.Description>
          </div>

          <SuiAuthPanel embedded />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function VaultAction({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link href={href} className="group flex flex-col items-center gap-1.5">
      <motion.div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-gray/15 bg-muted/80 text-sui transition-colors group-hover:border-sui/30 group-hover:bg-sui/10"
        whileHover={{ scale: 1.08, y: -2 }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: "spring", stiffness: 400, damping: 17 }}
      >
        {icon}
      </motion.div>
      <span className="text-[11px] text-gray transition-colors group-hover:text-foreground">{label}</span>
    </Link>
  );
}

function TechRow({ label, value, href }: { label: string; value: string; href?: string }) {
  const content = (
    <>
      <span className="text-gray">{label}</span>
      <span className="min-w-0 break-all font-mono text-foreground/80">{value}</span>
      {href && <ExternalLink className="h-3 w-3 text-gray" />}
    </>
  );
  if (!href) {
    return <div className="grid grid-cols-[92px_1fr_auto] items-center gap-2 text-[11px]">{content}</div>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="grid grid-cols-[92px_1fr_auto] items-center gap-2 text-[11px] hover:text-sui">
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
