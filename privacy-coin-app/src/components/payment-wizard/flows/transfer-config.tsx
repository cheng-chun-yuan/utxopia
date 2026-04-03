import { Shield } from "lucide-react";
import type { FlowConfig } from "../payment-wizard";

async function resolveStealthRecipient(address: string) {
  try {
    const { decodeStealthMetaAddress } = await import("@privacy-coin/sdk");

    // TODO: SNS resolution requires a ConnectionAdapter — implement when SNS is live
    // For now, only support direct pcoin: stealth addresses

    // Direct stealth meta address
    if (address.startsWith("pcoin:")) {
      return decodeStealthMetaAddress(address);
    }

    return null;
  } catch {
    return null;
  }
}

export const transferConfig: FlowConfig = {
  mode: "stealth",
  label: "Transfer",
  recipientLabel: "Recipient",
  recipientPlaceholder: "Stealth address or .btcpro.sol name",
  recipientIcon: <Shield className="w-full h-full" />,
  validateRecipient: (addr) => addr.startsWith("pcoin:") || addr.includes(".sol"),
  resolveRecipient: resolveStealthRecipient,
  confirmLabel: "Send Privately",
};
