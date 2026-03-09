import { useState, useCallback, useEffect } from "react";
import * as Passkeys from "react-native-passkeys";
import {
  getStoredCredentialId,
  storeCredentialId,
  storeSeed,
  loadSeed,
  clearAll,
} from "@/lib/storage";

const RP_NAME = "Aegis";
const RP_ID = "aegis.xyz";

function bytesToBase64URL(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function randomBase64URL(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64URL(bytes);
}

export interface UsePasskeyReturn {
  isSupported: boolean;
  hasCredential: boolean;
  isLoading: boolean;
  error: string | null;
  register: () => Promise<Uint8Array | null>;
  authenticate: () => Promise<Uint8Array | null>;
  clearCredential: () => void;
}

export function usePasskey(): UsePasskeyReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [hasCredential, setHasCredential] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsSupported(Passkeys.isSupported());
    getStoredCredentialId().then((id) => {
      setHasCredential(!!id);
    });
  }, []);

  const register = useCallback(async (): Promise<Uint8Array | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const credential = await Passkeys.create({
        rp: { name: RP_NAME, id: RP_ID },
        user: {
          id: randomBase64URL(32),
          name: "aegis-user",
          displayName: "Aegis User",
        },
        challenge: randomBase64URL(32),
        pubKeyCredParams: [
          { alg: -7, type: "public-key" }, // ES256
          { alg: -257, type: "public-key" }, // RS256
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      });

      if (!credential) {
        // User cancelled
        return null;
      }

      // Generate random 32-byte seed (PRF not reliably available on native).
      // The seed is stored encrypted at OS level via SecureStore.
      // The passkey serves as the biometric authentication gate.
      const seed = new Uint8Array(32);
      crypto.getRandomValues(seed);
      await storeSeed(seed);

      await storeCredentialId(credential.id);
      setHasCredential(true);

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.message.includes("cancelled") ||
          err.message.includes("canceled")
        ) {
          setError(null);
          return null;
        }
        setError(err.message);
      } else {
        setError("Failed to create passkey");
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const authenticate = useCallback(async (): Promise<Uint8Array | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const storedId = await getStoredCredentialId();

      const credential = await Passkeys.get({
        rpId: RP_ID,
        challenge: randomBase64URL(32),
        allowCredentials: storedId
          ? [{ id: storedId, type: "public-key" }]
          : [],
        userVerification: "required",
      });

      if (!credential) {
        // User cancelled
        return null;
      }

      // Load seed from SecureStore (encrypted at OS level)
      const seed = await loadSeed();
      if (!seed) {
        throw new Error(
          "No saved key found. This can happen if you registered on a different device. " +
            "Please create a new account on this device.",
        );
      }

      if (!storedId) {
        await storeCredentialId(credential.id);
        setHasCredential(true);
      }

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.message.includes("cancelled") ||
          err.message.includes("canceled")
        ) {
          setError(null);
          return null;
        }
        setError(err.message);
      } else {
        setError("Failed to authenticate with passkey");
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearCredential = useCallback(() => {
    clearAll();
    setHasCredential(false);
  }, []);

  return {
    isSupported,
    hasCredential,
    isLoading,
    error,
    register,
    authenticate,
    clearCredential,
  };
}
