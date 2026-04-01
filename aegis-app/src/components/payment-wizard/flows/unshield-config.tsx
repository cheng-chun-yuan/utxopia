import { Wallet } from "lucide-react";
import { isValidSolanaAddress } from "@/components/btc-widget/pay-flow/helpers";
import type { FlowConfig } from "../payment-wizard";

export const unshieldConfig: FlowConfig = {
  mode: "public",
  label: "Unshield",
  recipientLabel: "Solana Wallet",
  recipientPlaceholder: "Solana wallet address",
  recipientIcon: <Wallet className="w-full h-full" />,
  defaultRecipientFromWallet: true,
  validateRecipient: isValidSolanaAddress,
  privacyWarning: "This will reveal your Solana address on-chain",
  confirmLabel: "Unshield",
};
