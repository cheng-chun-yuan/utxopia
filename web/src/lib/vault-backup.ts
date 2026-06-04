"use client";

import { UTXOpiaClient } from "@utxopia/sdk";

const BACKUP_STATUS_PREFIX = "utxo:backup:";

export type BackupIdentityKind = "passkey" | "wallet" | "auth" | "unknown";

export interface VaultBackupPayload {
  version: 1;
  app: "UTXOpia";
  warning: string;
  exportedAt: string;
  identity: string;
  keys: Record<string, unknown>;
}

export function getBackupIdentityForKeys(keys: {
  solanaPublicKey?: Uint8Array | number[];
} | null): string | null {
  if (!keys) return null;
  if (isPasskeyVault(keys)) {
    return getPasskeyBackupIdentity();
  }
  const pubkey = keys.solanaPublicKey;
  if (pubkey && Array.from(pubkey).some((byte) => byte !== 0)) {
    return `wallet:${Buffer.from(pubkey).toString("hex")}`;
  }
  return "vault:unknown";
}

export function getPasskeyBackupIdentity(): string {
  if (typeof window === "undefined") return "passkey:default";
  const credentialId = localStorage.getItem("utxo:passkey_credential_id") || "default";
  return `passkey:${credentialId}`;
}

export function hasVaultBackup(identity: string | null): boolean {
  if (!identity || typeof window === "undefined") return false;
  return localStorage.getItem(BACKUP_STATUS_PREFIX + identity) === "1";
}

export function hasBackupForKeys(keys: {
  solanaPublicKey?: Uint8Array | number[];
} | null): boolean {
  return hasVaultBackup(getBackupIdentityForKeys(keys));
}

export function markVaultBackupComplete(identity: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(BACKUP_STATUS_PREFIX + identity, "1");
}

export function createVaultBackupPayload(identity: string): VaultBackupPayload {
  const keys = UTXOpiaClient.instance().serializeKeys();
  if (!keys) {
    throw new Error("No vault keys available to back up.");
  }
  return {
    version: 1,
    app: "UTXOpia",
    warning: "This backup can recover your private UTXOpia vault. Store it offline. Do not share it.",
    exportedAt: new Date().toISOString(),
    identity,
    keys,
  };
}

export function downloadVaultBackup(identity: string): void {
  const payload = createVaultBackupPayload(identity);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `utxopia-vault-backup-${payload.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function isPasskeyVault(keys: {
  solanaPublicKey?: Uint8Array | number[];
}): boolean {
  const pubkey = keys.solanaPublicKey;
  return !!pubkey && Array.from(pubkey).every((byte) => byte === 0);
}
