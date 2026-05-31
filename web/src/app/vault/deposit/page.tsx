"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, Bitcoin, Check, Copy, Shield, Wallet } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { ShieldFlow } from "@/components/shield-flow";
import { SuiAuthPanel } from "@/components/sui/sui-auth-panel";
import { useChainEnvironment } from "@/lib/chain-environment";
import { hrefWithChain } from "@/lib/network-config";
import {
  getSuiAuthState,
  SUI_AUTH_CHANGE_EVENT,
  type SuiAuthState,
} from "@/lib/sui/client";
import { useUTXOpiaStore } from "@/stores";
import { cn } from "@/lib/utils";

export default function DepositPage() {
  const { networkId, config } = useChainEnvironment();

  if (config.chain === "sui") {
    return <SuiDepositPage networkId={networkId === "sui-regtest" ? "sui-regtest" : "sui-testnet"} />;
  }

  return (
    <FlowPageLayout
      backHref={hrefWithChain("/vault", networkId)}
      backLabel="Back"
      width={520}
      badges={[
        {
          icon: <Shield className="w-full h-full" />,
          label: "Shield",
          color: "privacy",
        },
      ]}
      titleIcon={<ArrowDownToLine className="w-full h-full" />}
      title="Shield Tokens"
      description="Deposit any token into the privacy pool"
    >
      <ShieldFlow />
    </FlowPageLayout>
  );
}

function SuiDepositPage({ networkId }: { networkId: "sui-testnet" | "sui-regtest" }) {
  const stealthAddress = useUTXOpiaStore((s) => s.stealthAddressEncoded);
  const [copied, setCopied] = useState(false);
  const [suiAuth, setSuiAuth] = useState<SuiAuthState | null>(null);
  const faucetHref = useMemo(() => {
    const href = hrefWithChain("/faucet", networkId);
    if (!stealthAddress) return href;
    const url = new URL(href, "https://app.utxopia.local");
    url.searchParams.set("address", stealthAddress);
    return `${url.pathname}?${url.searchParams.toString()}`;
  }, [networkId, stealthAddress]);

  useEffect(() => {
    const refresh = () => setSuiAuth(getSuiAuthState());
    refresh();
    window.addEventListener(SUI_AUTH_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SUI_AUTH_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  async function copyAddress() {
    if (!stealthAddress) return;
    await navigator.clipboard?.writeText(stealthAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <FlowPageLayout
      backHref={hrefWithChain("/vault", networkId)}
      backLabel="Back"
      width={560}
      badges={[
        {
          icon: <Shield className="w-full h-full" />,
          label: networkId === "sui-regtest" ? "Sui Hybrid" : "Sui",
          color: "sol",
        },
      ]}
      titleIcon={<ArrowDownToLine className="w-full h-full" />}
      title="Deposit to Sui Vault"
      description="Fund your private Sui vault"
    >
      <div className="space-y-4">
        {!stealthAddress ? (
          <div className="space-y-4">
            <div className="rounded-[14px] border border-sui/15 bg-sui/5 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <Wallet className="h-4 w-4 text-sui" />
                Unlock Sui vault
              </div>
              <p className="text-xs leading-5 text-gray">
                Use passkey to create your private UTXO address. Connect Sui wallet when you need to sign Sui transactions.
              </p>
              {suiAuth?.address && (
                <p className="mt-2 truncate font-mono text-[11px] text-sui/70">
                  Sui wallet: {suiAuth.address}
                </p>
              )}
            </div>
            <SuiAuthPanel embedded />
          </div>
        ) : (
          <>
            <div className="rounded-[14px] border border-sui/15 bg-sui/5 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Private UTXO address</p>
                  <p className="text-xs text-gray">Use this address for Sui-side BTC deposits.</p>
                </div>
                <button
                  type="button"
                  onClick={copyAddress}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-[8px] border border-sui/15 text-sui transition-colors hover:bg-sui/10"
                  aria-label="Copy private UTXO address"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <code className="block break-all rounded-[10px] bg-background/60 p-3 font-mono text-[11px] text-sui">
                {stealthAddress}
              </code>
            </div>

            <div className="grid gap-3">
              <Link
                href={faucetHref}
                className={cn(
                  "flex items-center gap-4 rounded-[14px] border p-4 transition-colors",
                  networkId === "sui-regtest"
                    ? "border-warning/20 bg-warning/8 hover:bg-warning/12"
                    : "pointer-events-none border-gray/10 bg-muted/20 opacity-55",
                )}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-background/50 text-warning">
                  <Bitcoin className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">
                    {networkId === "sui-regtest" ? "Deposit regtest BTC" : "BTC faucet unavailable"}
                  </span>
                  <span className="mt-0.5 block text-xs text-gray">
                    {networkId === "sui-regtest"
                      ? "Use the hosted faucet to create a BTC deposit with OP_RETURN metadata."
                      : "Use a public testnet4 faucet once Sui testnet BTC deposits are enabled."}
                  </span>
                </span>
              </Link>

              <div className="rounded-[14px] border border-gray/10 bg-muted/20 p-4 opacity-70">
                <div className="flex items-center gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-background/50 text-sui">
                    <Wallet className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">Native SUI deposit</span>
                    <span className="mt-0.5 block text-xs text-gray">
                      Sui coin shielding needs the Sui transaction signer flow before it should be exposed here.
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </FlowPageLayout>
  );
}
