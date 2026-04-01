import { Shield } from "lucide-react";
import type { FlowConfig } from "../payment-wizard";

async function resolveStealthRecipient(address: string) {
  try {
    const { AegisClient, decodeStealthMetaAddress } = await import("@aegis/sdk");
    const client = AegisClient.isInitialized ? AegisClient.instance() : await AegisClient.init();

    // Try SNS resolution first
    if (address.includes(".sol") || !address.startsWith("aegis:")) {
      const meta = await client.resolveStealthAddress(address);
      if (meta) return meta;
    }

    // Direct stealth meta address
    if (address.startsWith("aegis:")) {
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
  validateRecipient: (addr) => addr.startsWith("aegis:") || addr.includes(".sol"),
  resolveRecipient: resolveStealthRecipient,
  confirmLabel: "Send Privately",
};
