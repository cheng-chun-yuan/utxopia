"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowRight,
  ChevronDown,
  Copy,
  Droplets,
  ExternalLink,
  Key,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  Settings,
  Shield,
  X,
} from "lucide-react";
import { SuiAuthPanel } from "@/components/sui/sui-auth-panel";
import { detectNetwork, getNetworkConfig, hrefWithChain, type NetworkId } from "@/lib/network-config";
import {
  clearSuiAuthState,
  getSuiAuthState,
  SUI_AUTH_CHANGE_EVENT,
  type SuiAuthState,
} from "@/lib/sui/client";
import { cn } from "@/lib/utils";
import { useUTXOpiaStore } from "@/stores";
import { useTokenPrices, type TokenPrices } from "@/hooks/use-token-prices";

type RpcState = "idle" | "loading" | "ok" | "error";
type SuiConfig = NonNullable<ReturnType<typeof getNetworkConfig>["sui"]>;

interface ObjectProbe {
  state: RpcState;
  version?: string;
  digest?: string;
  error?: string;
}

const SUI_VAULT_TOKENS = [
  {
    symbol: "zkBTC",
    aliases: ["zkBTC", "BTC"],
    name: "Shielded Bitcoin",
    decimals: 8,
    logo: "/tokens/zkbtc.png",
    priceKey: "btc",
  },
  {
    symbol: "zkSUI",
    aliases: ["zkSUI", "SUI"],
    name: "Shielded Sui",
    decimals: 9,
    logo: "/tokens/sui.png",
    priceKey: "sui",
  },
] as const;

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
  const [authOpen, setAuthOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return !!(hash.get("id_token") || hash.get("error"));
  });
  const [suiAuth, setSuiAuth] = useState<SuiAuthState | null>(null);
  const tokenPrices = useTokenPrices();
  const {
    balancesByToken,
    depositCount,
    isLoading: isLoadingInbox,
    refresh: refreshInbox,
  } = useSuiVaultBalances();
  const stealthAddressEncoded = useUTXOpiaStore((s) => s.stealthAddressEncoded);
  const clearKeys = useUTXOpiaStore((s) => s.clearKeys);
  const identity = stealthAddressEncoded;
  const suiAccount = suiAuth?.address ?? null;
  const totalUsd = useMemo(
    () => computeSuiVaultUsd(balancesByToken, tokenPrices),
    [balancesByToken, tokenPrices],
  );
  const btcEquivalent = tokenPrices.btc && tokenPrices.btc > 0 ? totalUsd / tokenPrices.btc : 0;

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
    const refresh = () => setSuiAuth(getSuiAuthState());
    refresh();
    window.addEventListener(SUI_AUTH_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SUI_AUTH_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  function signOut() {
    clearSuiAuthState();
    clearKeys();
    setSuiAuth(null);
  }

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
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {identity ? (
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(identity)}
                className="group flex min-w-0 items-center gap-1.5 rounded-full bg-sui/10 px-2.5 py-1.5 transition-colors hover:bg-sui/15"
                title="Copy UTXO address"
              >
                <Key className="h-3.5 w-3.5 shrink-0 text-sui" />
                <code className="truncate font-mono text-[12px] text-sui">
                  {shorten(identity, 10, 8)}
                </code>
                <Copy className="h-3 w-3 shrink-0 text-sui/40 transition-colors group-hover:text-sui" />
              </button>
            ) : (
              <span className="text-body2-semibold text-foreground">UTXO Address</span>
            )}
            {suiAccount && !identity && (
              <span className="max-w-[180px] truncate rounded-full border border-sui/15 bg-sui/5 px-2 py-1 font-mono text-[10px] text-sui/70">
                {shorten(suiAccount, 8, 6)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-sui/20 bg-sui/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sui">
              {networkId === "sui-regtest" ? "Sui Hybrid" : "Sui Testnet"}
            </span>
            {identity && (
              <button
                type="button"
                onClick={signOut}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-gray/50 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sui/40"
                aria-label="Log out"
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center pb-5 pt-3 text-center">
          {identity ? (
            <div className="w-full">
              <div className="py-6">
                {isLoadingInbox ? (
                  <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-sui" />
                ) : (
                  <>
                    <motion.p
                      className="mb-1 text-[36px] font-bold leading-none tracking-tight text-foreground sm:text-[42px]"
                      key={totalUsd.toFixed(2)}
                      initial={{ opacity: 0.6, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, ease: "easeOut" }}
                    >
                      ${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </motion.p>
                    <p className="flex items-center justify-center gap-1.5 font-mono text-body2 text-gray/60">
                      {btcEquivalent.toFixed(8)} BTC
                      <button
                        type="button"
                        onClick={() => refreshInbox(undefined, true)}
                        disabled={isLoadingInbox}
                        className="rounded p-0.5 text-gray/30 transition-colors hover:text-sui disabled:opacity-50"
                        title="Refresh"
                      >
                        <RefreshCw className={cn("h-3 w-3", isLoadingInbox && "animate-spin")} />
                      </button>
                    </p>
                  </>
                )}
              </div>

              <div className="mb-6 flex items-center justify-center gap-5 sm:gap-8">
                <VaultAction href={hrefWithChain("/vault/deposit", networkId)} icon={<ArrowDownToLine className="h-5 w-5" />} label="Deposit" />
                {networkId === "sui-regtest" && (
                  <VaultAction href={hrefWithChain("/faucet", networkId)} icon={<Droplets className="h-5 w-5" />} label="Faucet" />
                )}
                <VaultAction href={hrefWithChain("/send", networkId)} icon={<Send className="h-5 w-5" />} label="Send" />
              </div>

              {depositCount > 0 && (
                <div className="mb-5 flex justify-center">
                  <Link
                    href={hrefWithChain("/vault/activity", networkId)}
                    className="flex items-center gap-1 text-[11px] text-gray/40 transition-colors hover:text-gray/60"
                  >
                    View History <ChevronDown className="-rotate-90 h-3 w-3" />
                  </Link>
                </div>
              )}

              <div className="mb-5 text-left">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-gray/50">Tokens</span>
                  {depositCount > 0 && (
                    <Link
                      href={hrefWithChain("/vault/activity?tab=notes", networkId)}
                      className="inline-flex items-center gap-0.5 text-[11px] text-sui/70 transition-colors hover:text-sui"
                    >
                      View All
                      <ChevronDown className="-rotate-90 h-3 w-3" />
                    </Link>
                  )}
                </div>
                <div className="overflow-hidden rounded-[14px] border border-gray/10 divide-y divide-gray/8">
                  <SuiTokenRows
                    balancesByToken={balancesByToken}
                    isLoading={isLoadingInbox}
                    networkId={networkId}
                    tokenPrices={tokenPrices}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center py-10">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-sui/20 bg-sui/10">
                <Shield className="h-7 w-7 text-sui" />
              </div>
              <h1 className="mb-1 text-[22px] font-bold text-foreground">UTXO Address</h1>
              <p className="mb-6 text-caption text-gray/60">
                Unlock your private vault to view zkBTC and zkSUI balances.
              </p>
              <button
                type="button"
                onClick={() => setAuthOpen(true)}
                className="inline-flex items-center gap-2 rounded-full bg-sui px-7 py-3 text-body2 font-semibold text-background transition-opacity hover:opacity-90 active:scale-95"
              >
                <Key className="h-4 w-4" />
                Get Started
              </button>
            </div>
          )}
        </div>

        <div className="mb-4 rounded-[10px] bg-muted/30 px-3 py-3">
          <div className="flex items-center gap-4">
            {[
              { step: "1", label: "Deposit" },
              { step: "2", label: "Send" },
              { step: "3", label: "Cash Out" },
            ].map((s, i) => (
              <div key={s.step} className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] font-bold text-sui/45">{s.step}</span>
                  <span className="text-[11px] text-gray/50">{s.label}</span>
                </div>
                {i < 2 && <ChevronDown className="-rotate-90 h-3 w-3 text-gray/15" />}
              </div>
            ))}
            <div className="flex-1" />
            <div className="flex items-center gap-1.5">
              <Shield className="h-3 w-3 text-sui/45" />
              <span className="text-[10px] font-medium text-sui/45">ZK</span>
            </div>
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

          <SuiAuthPanel embedded onAuthenticated={() => onOpenChange(false)} />
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

function SuiTokenRows({
  balancesByToken,
  isLoading,
  networkId,
  tokenPrices,
}: {
  balancesByToken: Record<string, bigint>;
  isLoading: boolean;
  networkId: NetworkId;
  tokenPrices: TokenPrices;
}) {
  const hasAnyBalance = SUI_VAULT_TOKENS.some((token) => getTokenBalance(balancesByToken, token.aliases) > 0n);

  if (!hasAnyBalance && !isLoading) {
    return (
      <div className="flex flex-col items-center px-4 py-8 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-sui/20 bg-sui/10">
          <ArrowDownToLine className="h-5 w-5 text-sui" />
        </div>
        <p className="mb-1 text-sm font-medium text-foreground">Ready to go private?</p>
        <p className="mb-4 text-xs text-gray/50">
          Deposit BTC or SUI to start.
        </p>
        <Link
          href={hrefWithChain("/vault/deposit", networkId)}
          className="inline-flex items-center gap-2 rounded-full bg-sui px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 active:scale-[0.98]"
        >
          Make Your First Deposit
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  const sorted = [...SUI_VAULT_TOKENS].sort((a, b) => {
    const aRaw = getTokenBalance(balancesByToken, a.aliases);
    const bRaw = getTokenBalance(balancesByToken, b.aliases);
    if (aRaw > 0n && bRaw === 0n) return -1;
    if (aRaw === 0n && bRaw > 0n) return 1;
    const aUsd = tokenUsdValue(aRaw, a.decimals, tokenPrices[a.priceKey]);
    const bUsd = tokenUsdValue(bRaw, b.decimals, tokenPrices[b.priceKey]);
    return bUsd - aUsd;
  });

  return sorted.map((token) => {
    const rawBalance = getTokenBalance(balancesByToken, token.aliases);
    const balanceNum = Number(rawBalance) / 10 ** token.decimals;
    const hasBalance = rawBalance > 0n;
    const balance = balanceNum.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: Math.min(token.decimals, 6),
    });
    const usdValue = tokenUsdValue(rawBalance, token.decimals, tokenPrices[token.priceKey]);

    return (
      <div
        key={token.symbol}
        className={cn(
          "flex h-[60px] items-center gap-3 px-4 transition-colors",
          hasBalance ? "hover:bg-muted/40" : "opacity-40",
        )}
      >
        <img src={token.logo} alt={token.symbol} className="h-9 w-9 rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="text-body2-semibold text-foreground">{token.symbol}</p>
          <p className="text-[11px] text-gray/50">{token.name}</p>
        </div>
        <div className="text-right">
          {isLoading ? (
            <Loader2 className="ml-auto h-4 w-4 animate-spin text-sui" />
          ) : hasBalance ? (
            <>
              <p className="font-mono text-body2-semibold text-foreground">{balance}</p>
              <p className="font-mono text-[11px] text-gray/45">
                ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </>
          ) : (
            <p className="font-mono text-body2 text-gray/30">0.00</p>
          )}
        </div>
      </div>
    );
  });
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

function useSuiVaultBalances() {
  const balancesByToken = useUTXOpiaStore((s) => s.inboxBalancesByToken);
  const depositCount = useUTXOpiaStore((s) => s.inboxDepositCount);
  const isLoading = useUTXOpiaStore((s) => s.inboxLoading);
  const refresh = useUTXOpiaStore((s) => s.refreshInbox);

  return { balancesByToken, depositCount, isLoading, refresh };
}

function computeSuiVaultUsd(
  balancesByToken: Record<string, bigint>,
  tokenPrices: TokenPrices,
): number {
  return SUI_VAULT_TOKENS.reduce((total, token) => {
    const raw = getTokenBalance(balancesByToken, token.aliases);
    return total + tokenUsdValue(raw, token.decimals, tokenPrices[token.priceKey]);
  }, 0);
}

function getTokenBalance(balancesByToken: Record<string, bigint>, aliases: readonly string[]): bigint {
  return aliases.reduce((sum, alias) => sum + (balancesByToken[alias] ?? 0n), 0n);
}

function tokenUsdValue(rawBalance: bigint, decimals: number, price: number | null): number {
  if (!price) return 0;
  return (Number(rawBalance) / 10 ** decimals) * price;
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
