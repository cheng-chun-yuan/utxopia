import { Bitcoin } from "lucide-react";
import { SERVICE_FEE_SATS } from "@/components/btc-widget/pay-flow/helpers";
import type { FlowConfig } from "../payment-wizard";

export const withdrawConfig: FlowConfig = {
  mode: "btc",
  label: "Withdraw BTC",
  recipientLabel: "Bitcoin Address",
  recipientPlaceholder: "Bitcoin address (P2WPKH, P2WSH, or P2TR)",
  recipientIcon: <Bitcoin className="w-full h-full" />,
  validateRecipient: () => false, // Validated async via btc-address module
  showFeeBreakdown: true,
  privacyWarning: "This will reveal your BTC withdrawal address on-chain",
  confirmLabel: "Withdraw BTC",
  computeServiceFee: (amountSats: number) => SERVICE_FEE_SATS + Math.floor(amountSats * 0.002),
};
