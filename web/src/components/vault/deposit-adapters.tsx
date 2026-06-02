"use client";

import { useMemo, type ReactNode } from "react";
import { Bitcoin, PlusCircle, Wallet } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { ShieldFlow } from "@/components/shield-flow";
import { SuiAuthPanel } from "@/components/sui/sui-auth-panel";
import { ChainDepositPage, type ChainDepositAction } from "@/components/vault/chain-deposit-page";
import { useSuiAuthState } from "@/hooks/sui/use-sui-auth-state";
import {
  getChainAdapter,
  isChainHybridNetwork,
  networkForChain,
  type ChainId,
} from "@/lib/chain-registry";
import { hrefWithChain, type NetworkConfig, type NetworkId } from "@/lib/network-config";
import { useUTXOpiaStore } from "@/stores";

interface ChainDepositRouteProps {
  networkId: NetworkId;
  config: NetworkConfig;
}

type ChainDepositRenderer = (props: ChainDepositRouteProps) => ReactNode;

const DEPOSIT_RENDERERS: Record<ChainId, ChainDepositRenderer> = {
  solana: SolanaDepositPage,
  sui: SuiDepositPage,
};

function getChainDepositRenderer(config: NetworkConfig): ChainDepositRenderer {
  return DEPOSIT_RENDERERS[getChainAdapter(config).id];
}

export function renderChainDeposit(props: ChainDepositRouteProps): ReactNode {
  return getChainDepositRenderer(props.config)(props);
}

function SolanaDepositPage({ networkId }: ChainDepositRouteProps) {
  return (
    <FlowPageLayout
      backHref={hrefWithChain("/vault", networkId)}
      backLabel="Back"
      width={520}
      badges={[
        {
          icon: <PlusCircle className="w-full h-full" />,
          label: "Add funds",
          color: "privacy",
        },
      ]}
      titleIcon={<PlusCircle className="w-full h-full" />}
      title="Add Funds"
      description="Move BTC, SOL, or supported tokens into your private balance"
    >
      <ShieldFlow />
    </FlowPageLayout>
  );
}

function SuiDepositPage({ networkId }: ChainDepositRouteProps) {
  const suiNetwork = networkForChain(networkId, "sui");
  const stealthAddress = useUTXOpiaStore((s) => s.stealthAddressEncoded);
  const suiAuth = useSuiAuthState();
  const isHybrid = isChainHybridNetwork(suiNetwork, "sui");
  const faucetHref = useMemo(() => {
    const href = hrefWithChain("/faucet", suiNetwork);
    if (!stealthAddress) return href;
    const url = new URL(href, "https://app.utxopia.local");
    url.searchParams.set("address", stealthAddress);
    return `${url.pathname}?${url.searchParams.toString()}`;
  }, [suiNetwork, stealthAddress]);

  const actions = useMemo<ChainDepositAction[]>(() => [
    {
      href: faucetHref,
      icon: <Bitcoin className="h-5 w-5" />,
      title: isHybrid ? "Deposit regtest BTC" : "BTC faucet unavailable",
      description: isHybrid
        ? "Use the hosted faucet to create a BTC deposit with OP_RETURN metadata."
        : "Use a public testnet4 faucet once Sui testnet BTC deposits are enabled.",
      disabled: !isHybrid,
      tone: "warning",
    },
    {
      icon: <Wallet className="h-5 w-5" />,
      title: "Native SUI deposit",
      description: "Sui coin shielding needs the Sui transaction signer flow before it should be exposed here.",
      disabled: true,
      tone: "default",
    },
  ], [faucetHref, isHybrid]);

  return (
    <ChainDepositPage
      backHref={hrefWithChain("/vault", suiNetwork)}
      badgeLabel={isHybrid ? "Sui Hybrid" : "Sui"}
      title="Deposit to Sui Vault"
      description="Fund your private Sui vault"
      unlockTitle="Unlock Sui vault"
      unlockDescription="Use passkey or Sui wallet signature to create your private UTXO address."
      connectedAccountLabel="Sui wallet"
      connectedAccount={suiAuth?.address}
      authPanel={<SuiAuthPanel embedded />}
      privateAddress={stealthAddress}
      privateAddressDescription="Use this private address for Sui-side BTC deposits."
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
