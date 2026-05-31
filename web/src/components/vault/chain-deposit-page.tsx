"use client";

import type { ReactNode } from "react";
import { ArrowDownToLine, Shield, Wallet } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { DepositActionCard } from "@/components/vault/deposit-action-card";
import { PrivateUtxoAddressCard } from "@/components/vault/private-utxo-address-card";
import { cn } from "@/lib/utils";

export interface ChainDepositAction {
  icon: ReactNode;
  title: string;
  description: string;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "warning";
  className?: string;
  iconClassName?: string;
}

interface ChainDepositPageProps {
  backHref: string;
  badgeLabel: string;
  title: string;
  description: string;
  unlockTitle: string;
  unlockDescription: string;
  connectedAccountLabel?: string;
  connectedAccount?: string | null;
  authPanel: ReactNode;
  privateAddress: string | null;
  privateAddressDescription: string;
  actions: ChainDepositAction[];
  theme?: {
    unlockCardClassName?: string;
    unlockIconClassName?: string;
    connectedAccountClassName?: string;
    addressCardClassName?: string;
    addressButtonClassName?: string;
    addressCodeClassName?: string;
  };
}

export function ChainDepositPage({
  backHref,
  badgeLabel,
  title,
  description,
  unlockTitle,
  unlockDescription,
  connectedAccountLabel,
  connectedAccount,
  authPanel,
  privateAddress,
  privateAddressDescription,
  actions,
  theme,
}: ChainDepositPageProps) {
  return (
    <FlowPageLayout
      backHref={backHref}
      backLabel="Back"
      width={560}
      badges={[
        {
          icon: <Shield className="w-full h-full" />,
          label: badgeLabel,
          color: "sol",
        },
      ]}
      titleIcon={<ArrowDownToLine className="w-full h-full" />}
      title={title}
      description={description}
    >
      <div className="space-y-4">
        {!privateAddress ? (
          <div className="space-y-4">
            <div className={cn("rounded-[14px] border p-4", theme?.unlockCardClassName)}>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <Wallet className={cn("h-4 w-4", theme?.unlockIconClassName)} />
                {unlockTitle}
              </div>
              <p className="text-xs leading-5 text-gray">{unlockDescription}</p>
              {connectedAccount && connectedAccountLabel && (
                <p className={cn("mt-2 truncate font-mono text-[11px]", theme?.connectedAccountClassName)}>
                  {connectedAccountLabel}: {connectedAccount}
                </p>
              )}
            </div>
            {authPanel}
          </div>
        ) : (
          <>
            <PrivateUtxoAddressCard
              address={privateAddress}
              description={privateAddressDescription}
              cardClassName={theme?.addressCardClassName}
              buttonClassName={theme?.addressButtonClassName}
              codeClassName={theme?.addressCodeClassName}
            />
            <div className="grid gap-3">
              {actions.map((action) => (
                <DepositActionCard
                  key={`${action.title}:${action.href ?? "static"}`}
                  icon={action.icon}
                  title={action.title}
                  description={action.description}
                  href={action.href}
                  disabled={action.disabled}
                  tone={action.tone}
                  className={action.className}
                  iconClassName={action.iconClassName}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </FlowPageLayout>
  );
}
