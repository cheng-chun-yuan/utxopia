import { bytesToHex, type StealthMetaAddress } from "@utxopia/sdk";
import type { ChainId } from "@/lib/chain-registry";
import type { NetworkId } from "@/lib/network-config";

const SOL_HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SUI_HANDLE_RE = /^[a-z0-9]{1,63}$/;

export type PrivateNameClaimResult = {
  normalizedName: string;
  digest?: string | null;
};

export type ClaimPrivateReceiveNameInput = {
  chain: ChainId;
  name: string;
  networkId: NetworkId;
  suiAddress?: string | null;
  loginId?: string | null;
  stealthAddress?: Pick<StealthMetaAddress, "viewingPubKey" | "mpk"> | null;
  solanaClaim?: (handle: string) => Promise<boolean>;
};

export function normalizePrivateNameHandle(input: string, chain: ChainId) {
  const trimmed = input.trim().toLowerCase();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const suffix = chain === "sui" ? ".utxopia.sui" : ".utxopia.sol";
  const handle = withoutAt.endsWith(suffix)
    ? withoutAt.slice(0, -1 * suffix.length)
    : withoutAt;
  const re = chain === "sui" ? SUI_HANDLE_RE : SOL_HANDLE_RE;
  if (!re.test(handle)) {
    throw new Error(chain === "sui"
      ? "Choose a Sui name with lowercase letters and numbers only."
      : "Choose a Solana name with lowercase letters, numbers, or hyphens.");
  }
  return handle;
}

export function formatPrivateReceiveName(handleOrName: string, chain: ChainId) {
  const handle = normalizePrivateNameHandle(handleOrName, chain);
  return chain === "sui" ? `${handle}.utxopia.sui` : `${handle}.utxopia.sol`;
}

export async function claimPrivateReceiveName(input: ClaimPrivateReceiveNameInput): Promise<PrivateNameClaimResult> {
  const handle = normalizePrivateNameHandle(input.name, input.chain);
  if (input.chain === "solana") {
    if (!input.solanaClaim) throw new Error("Solana name claim function is not configured.");
    const ok = await input.solanaClaim(handle);
    if (!ok) throw new Error("Could not claim Solana private name.");
    return { normalizedName: formatPrivateReceiveName(handle, "solana") };
  }

  if (!input.stealthAddress) throw new Error("Create a private wallet before claiming a SuiNS name.");
  if (!input.suiAddress) throw new Error("Connect or create a Sui login before claiming a SuiNS name.");

  const response = await fetch("/api/sui/suins/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle,
      suiAddress: input.suiAddress,
      loginId: input.loginId ?? input.suiAddress,
      network: input.networkId,
      viewingPubKey: bytesToHex(input.stealthAddress.viewingPubKey),
      mpk: bytesToHex(input.stealthAddress.mpk),
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Could not claim SuiNS name.");
  }

  return {
    normalizedName: data.claim?.normalizedName ?? formatPrivateReceiveName(handle, "sui"),
    digest: data.claim?.createDigest ?? null,
  };
}
