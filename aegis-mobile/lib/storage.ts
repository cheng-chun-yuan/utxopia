import * as SecureStore from "expo-secure-store";

const CREDENTIAL_KEY = "aegis:passkey_cred_id";
const SEED_KEY = "aegis:passkey_seed";
const KEYS_KEY = "aegis:derived_keys";

export async function getStoredCredentialId(): Promise<string | null> {
  return SecureStore.getItemAsync(CREDENTIAL_KEY);
}

export async function storeCredentialId(id: string): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIAL_KEY, id);
}

export async function storeSeed(seed: Uint8Array): Promise<void> {
  const hex = Array.from(seed)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await SecureStore.setItemAsync(SEED_KEY, hex);
}

export async function loadSeed(): Promise<Uint8Array | null> {
  const hex = await SecureStore.getItemAsync(SEED_KEY);
  if (!hex) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function storeSerializedKeys(json: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS_KEY, json);
}

export async function loadSerializedKeys(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS_KEY);
}

export async function clearAll(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
  await SecureStore.deleteItemAsync(SEED_KEY);
  await SecureStore.deleteItemAsync(KEYS_KEY);
}
