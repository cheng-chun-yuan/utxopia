"use client";

import { useMemo } from "react";
import { ArrowDownToLine, Bitcoin, Shield, Wallet } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { ShieldFlow } from "@/components/shield-flow";
import { SuiAuthPanel } from "@/components/sui/sui-auth-panel";
import { ChainDepositPage, type ChainDepositAction } from "@/components/vault/chain-deposit-page";
import { useChainEnvironment } from "@/lib/chain-environment";
import { hrefWithChain } from "@/lib/network-config";
import { useSuiAuthState } from "@/hooks/sui/use-sui-auth-state";
import { useUTXOpiaStore } from "@/stores";

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
  const suiAuth = useSuiAuthState();
  const faucetHref = useMemo(() => {
    const href = hrefWithChain("/faucet", networkId);
    if (!stealthAddress) return href;
    const url = new URL(href, "https://app.utxopia.local");
    url.searchParams.set("address", stealthAddress);
    return `${url.pathname}?${url.searchParams.toString()}`;
  }, [networkId, stealthAddress]);

  const actions = useMemo<ChainDepositAction[]>(() => [
    {
      href: faucetHref,
      icon: <Bitcoin className="h-5 w-5" />,
      title: networkId === "sui-regtest" ? "Deposit regtest BTC" : "BTC faucet unavailable",
      description: networkId === "sui-regtest"
        ? "Use the hosted faucet to create a BTC deposit with OP_RETURN metadata."
        : "Use a public testnet4 faucet once Sui testnet BTC deposits are enabled.",
      disabled: networkId !== "sui-regtest",
      tone: "warning",
    },
    {
      icon: <Wallet className="h-5 w-5" />,
      title: "Native SUI deposit",
      description: "Sui coin shielding needs the Sui transaction signer flow before it should be exposed here.",
      disabled: true,
      tone: "default",
    },
  ], [faucetHref, networkId]);

  return (
    <ChainDepositPage
      backHref={hrefWithChain("/vault", networkId)}
      badgeLabel={networkId === "sui-regtest" ? "Sui Hybrid" : "Sui"}
      title="Deposit to Sui Vault"
      description="Fund your private Sui vault"
      unlockTitle="Unlock Sui vault"
      unlockDescription="Use passkey or Sui wallet signature to create your private UTXO address."
      connectedAccountLabel="Sui wallet"
      connectedAccount={suiAuth?.address}
      authPanel={<SuiAuthPanel embedded />}
      privateAddress={stealthAddress}
      privateAddressDescription="Use this address for Sui-side BTC deposits."
      actions={actions}
      theme={{
        unlockCardClassName: "border-sui/15 bg-sui/5",
        unlockIconClassName: "text-sui",
        connectedAccountClassName: "text-sui/70",
        addressCardClassName: "border-sui/15 bg-sui/5",
        addressButtonClassName: "border-sui/15 text-sui hover:bg-sui/10",
        addressCodeClassName: "text-sui",
      }}
    />
  );
}
