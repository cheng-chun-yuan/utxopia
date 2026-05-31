"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Droplets, Wallet, ExternalLink } from "lucide-react";
import { detectNetwork, getNetworkConfig, hrefWithChain } from "@/lib/network-config";
import { cn } from "@/lib/utils";

/**
 * Regtest BTC faucet — only renders when the active network's BTC layer is
 * `regtest` (i.e. the hybrid stack). On testnet4 / mainnet the page shows a
 * "not available on this network" hint instead of a working form, so the
 * route is safe to merge even before the backend wiring lands.
 *
 * Backend wiring lives at `/api/faucet/regtest`.
 */
export default function FaucetPage() {
  const network = useMemo(() => {
    try {
      const currentNetwork = detectNetwork();
      getNetworkConfig(currentNetwork);
      return currentNetwork;
    } catch {
      return null;
    }
  }, []);

  const isHybrid = network === "devnet-regtest" || network === "sui-regtest";
  const chainHref = (href: string) => network ? hrefWithChain(href, network) : href;
  const isSui = network === "sui-regtest";

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-[480px] mb-4 flex items-center justify-between relative z-10">
        <Link
          href={chainHref("/")}
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back home
        </Link>
        <span className="text-caption text-gray font-mono">
          {network ?? "?"}
        </span>
      </div>

      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-6",
          "w-[480px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10",
        )}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-[10px] bg-warning/10">
            <Droplets className="w-5 h-5 text-warning" />
          </div>
          <div>
            <h1 className="text-heading6 text-foreground">Regtest zkBTC airdrop</h1>
            <p className="text-caption text-gray">
              {isSui
                ? "Create a local BTC regtest deposit for your Sui vault."
                : "Deposit 0.001 regtest BTC into a UTXOpia stealth address."}
            </p>
          </div>
        </div>

        {isHybrid ? <FaucetForm isSui={isSui} network={network} /> : <NotAvailableNotice network={network ?? "unknown"} />}
      </div>
    </main>
  );
}

function NotAvailableNotice({ network }: { network?: string }) {
  return (
    <div className="space-y-3">
      <div className="p-4 rounded-[12px] bg-muted border border-gray/15">
        <p className="text-body2 text-gray-light">
          Faucet is only available on a <span className="text-warning font-mono">regtest</span>{" "}
          hybrid stack. The current network is{" "}
          <span className="text-foreground font-mono">{network ?? "unknown"}</span>.
        </p>
      </div>
      <div className="text-caption text-gray space-y-2">
        <p>To switch to the hybrid stack:</p>
        <pre className="bg-background/60 border border-gray/15 rounded-[10px] p-3 overflow-x-auto text-[11px] leading-relaxed">
{`# 1. Start regtest BTC + esplora
docker compose -f docker-compose.regtest.yml up -d

# 2. Switch backend to hybrid (Solana or Sui + regtest BTC)
docker compose -f docker-compose.hybrid.yml up --build -d

# 3. Sync the matching env
UTXOPIA_NETWORK=sui-regtest ./scripts/sync-env.sh`}
        </pre>
        <p className="pt-1">
          Public testnet4 / mainnet users should use{" "}
          <a
            className="text-privacy hover:underline inline-flex items-center gap-1"
            href="https://mempool.space/testnet4/faucet"
            target="_blank"
            rel="noreferrer"
          >
            mempool.space testnet4 faucet <ExternalLink className="w-3 h-3" />
          </a>{" "}
          instead.
        </p>
      </div>
    </div>
  );
}

type DripResult =
  | {
      kind: "ok";
      txid: string;
      blocksMined?: number;
      warning?: string;
      depositAddress?: string;
      opReturn?: string;
      amountSats?: number;
      dailyLimit?: number;
    }
  | { kind: "cooldown"; retryAfterSec: number; message: string }
  | { kind: "err"; message: string };

function FaucetForm({ isSui = false, network }: { isSui?: boolean; network: string }) {
  const [address, setAddress] = useState("");
  const [amountSats, setAmountSats] = useState(100_000);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<DripResult | null>(null);

  useEffect(() => {
    setResult(null);
  }, [address, amountSats]);

  // Live cooldown countdown so the user sees the seconds tick down.
  const [cooldownLeft, setCooldownLeft] = useState(0);
  useEffect(() => {
    if (result?.kind !== "cooldown") {
      setCooldownLeft(0);
      return;
    }
    setCooldownLeft(result.retryAfterSec);
    const iv = setInterval(() => {
      setCooldownLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(iv);
  }, [result]);

  const validAddress = /^utxo:[0-9a-fA-F]{192}$/.test(address.trim());

  async function handleDrip() {
    setSubmitting(true);
    setResult(null);
    try {
      const params = new URLSearchParams({ network });
      const res = await fetch(`/api/faucet/regtest?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.trim(), amountSats }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        txid?: string;
        blocksMined?: number;
        warning?: string;
        depositAddress?: string;
        opReturn?: string;
        amountSats?: number;
        dailyLimit?: number;
        retryAfterSec?: number;
        error?: string;
      };
      if (res.status === 429 && typeof body.retryAfterSec === "number") {
        setResult({
          kind: "cooldown",
          retryAfterSec: body.retryAfterSec,
          message: body.error ?? `cooldown active — try again in ${body.retryAfterSec}s`,
        });
      } else if (!res.ok || !body.ok) {
        setResult({ kind: "err", message: body.error ?? `HTTP ${res.status}` });
      } else {
        setResult({
          kind: "ok",
          txid: body.txid ?? "",
          blocksMined: body.blocksMined,
          warning: body.warning,
          depositAddress: body.depositAddress,
          opReturn: body.opReturn,
          amountSats: body.amountSats,
          dailyLimit: body.dailyLimit,
        });
      }
    } catch (e) {
      setResult({ kind: "err", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  const cooldownActive = result?.kind === "cooldown" && cooldownLeft > 0;
  const disabled = !validAddress || submitting || amountSats <= 0 || cooldownActive;

  return (
    <div className="space-y-4">
      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Recipient UTXOpia address
        </label>
        <div className="relative">
          <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray" />
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="utxo:..."
            className={cn(
              "w-full p-3 pl-10 bg-muted border border-gray/15 rounded-[12px]",
              "text-body2 font-mono text-foreground placeholder:text-gray",
              "outline-none focus:border-warning/40 transition-colors",
            )}
          />
        </div>
      </div>

      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Amount (sats)
        </label>
        <input
          type="number"
          min={1}
          max={100_000}
          step={1000}
          value={amountSats}
          onChange={(e) => setAmountSats(Number(e.target.value) || 0)}
          className={cn(
            "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
            "text-body2 font-mono text-foreground",
            "outline-none focus:border-warning/40 transition-colors",
          )}
        />
        <p className="text-caption text-gray mt-1 pl-2">
          {(amountSats / 1e8).toFixed(8)} BTC. Limit: 3 airdrops per day.
        </p>
      </div>

      <button
        onClick={handleDrip}
        disabled={disabled}
        className="btn-primary w-full"
      >
        <Droplets className="w-5 h-5" />
        {submitting
          ? "Creating deposit…"
          : cooldownActive
            ? `Wait ${cooldownLeft}s`
            : "Airdrop zkBTC deposit"}
      </button>

      {result?.kind === "ok" && (
        <div className="p-3 rounded-[10px] border border-success/30 bg-success/5 text-caption text-success space-y-1">
          <div>
            Deposit broadcast + confirmed{result.blocksMined != null ? ` (${result.blocksMined} block${result.blocksMined === 1 ? "" : "s"} mined)` : ""}.
          </div>
          <div className="font-mono break-all">{result.txid || "(see backend log)"}</div>
          {result.depositAddress && (
            <div className="pt-1 text-success/80">
              Pool address: <span className="font-mono break-all">{result.depositAddress}</span>
            </div>
          )}
          {result.opReturn && (
            <div className="pt-1 text-success/80">
              OP_RETURN: <span className="font-mono break-all">{result.opReturn}</span>
            </div>
          )}
          {result.warning && (
            <div className="text-warning pt-1 border-t border-success/10">⚠ {result.warning}</div>
          )}
        </div>
      )}
      {result?.kind === "cooldown" && (
        <div className="p-3 rounded-[10px] border border-warning/30 bg-warning/5 text-caption text-warning">
          {cooldownLeft > 0 ? `Cooldown — try again in ${cooldownLeft}s` : "Cooldown cleared, try again."}
        </div>
      )}
      {result?.kind === "err" && (
        <div className="p-3 rounded-[10px] border border-error/30 bg-error/5 text-caption text-error">
          {result.message}
        </div>
      )}

      <p className="text-caption text-gray">
        {isSui
          ? "Use this during Sui Hybrid demos to create the same regtest BTC deposit shape: BTC output plus OP_RETURN metadata for the private note."
          : (
            <>
              Share this page with a tester and ask them for their <span className="font-mono">utxo:</span>{" "}
              address. The backend creates the regtest BTC deposit and the tracker credits the note after it sees the transaction.
            </>
          )}
      </p>
    </div>
  );
}
