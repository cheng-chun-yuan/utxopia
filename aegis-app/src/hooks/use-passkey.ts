"use client";

import { useState, useCallback, useEffect } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  bufferToBase64URLString,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const CREDENTIAL_STORAGE_KEY = "aegis:passkey_credential_id";
const SEED_STORAGE_KEY = "aegis:passkey_seed";
const PRF_SALT = sha256(new TextEncoder().encode("aegis-passkey-prf-v1"));

const RP_NAME = "Aegis";

function getRpId(): string {
  if (typeof window === "undefined") return "localhost";
  return window.location.hostname;
}

function getStoredCredentialId(): string | null {
  try {
    return localStorage.getItem(CREDENTIAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeCredentialId(id: string): void {
  try {
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, id);
  } catch {
    // localStorage unavailable
  }
}

export function clearStoredCredential(): void {
  try {
    localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
    localStorage.removeItem(SEED_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Fallback seed storage (used when PRF is not available) ──

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function storeFallbackSeed(seed: Uint8Array): void {
  try {
    localStorage.setItem(SEED_STORAGE_KEY, bytesToHex(seed));
  } catch {
    // ignore
  }
}

function loadFallbackSeed(): Uint8Array | null {
  try {
    const hex = localStorage.getItem(SEED_STORAGE_KEY);
    if (!hex) return null;
    return hexToBytes(hex);
  } catch {
    return null;
  }
}

// ── PRF extraction ──

/**
 * Try to extract PRF output from WebAuthn credential response.
 * Returns 32-byte seed or null if PRF not supported.
 */
function tryExtractPrfOutput(
  extensions: AuthenticationExtensionsClientOutputs | undefined,
): Uint8Array | null {
  if (!extensions) return null;

  const prf = (extensions as Record<string, unknown>).prf as
    | { results?: { first?: ArrayBuffer } }
    | undefined;
  if (!prf?.results?.first) return null;

  return sha256(new Uint8Array(prf.results.first));
}

function randomBase64URL(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bufferToBase64URLString(bytes.buffer as ArrayBuffer);
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
    setIsSupported(browserSupportsWebAuthn());
    setHasCredential(!!getStoredCredentialId());
  }, []);

  const register = useCallback(async (): Promise<Uint8Array | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const rpId = getRpId();

      const creationOptions: PublicKeyCredentialCreationOptionsJSON = {
        rp: { name: RP_NAME, id: rpId },
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
        extensions: {
          prf: {
            eval: { first: PRF_SALT.buffer as ArrayBuffer },
          },
        } as Record<string, unknown>,
      };

      const credential = await startRegistration({
        optionsJSON: creationOptions,
      });

      // Try PRF first
      let seed = tryExtractPrfOutput(credential.clientExtensionResults);

      if (!seed) {
        // PRF not supported — generate random seed and store locally.
        // The passkey serves as a biometric gate; the seed lives in localStorage.
        seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        storeFallbackSeed(seed);
      }

      storeCredentialId(credential.id);
      setHasCredential(true);

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.message.includes("cancelled")
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
      const rpId = getRpId();
      const storedId = getStoredCredentialId();

      const requestOptions: PublicKeyCredentialRequestOptionsJSON = {
        rpId,
        challenge: randomBase64URL(32),
        allowCredentials: storedId
          ? [{ id: storedId, type: "public-key" }]
          : [],
        userVerification: "required",
        extensions: {
          prf: {
            eval: { first: PRF_SALT.buffer as ArrayBuffer },
          },
        } as Record<string, unknown>,
      };

      const credential = await startAuthentication({
        optionsJSON: requestOptions,
      });

      // Try PRF first
      let seed = tryExtractPrfOutput(credential.clientExtensionResults);

      if (!seed) {
        // PRF not available — load fallback seed from localStorage
        seed = loadFallbackSeed();
        if (!seed) {
          throw new Error(
            "No saved key found. This can happen if you registered on a different device. " +
              "Please use the original device or connect a wallet instead.",
          );
        }
      }

      if (!storedId) {
        storeCredentialId(credential.id);
        setHasCredential(true);
      }

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.name === "NotAllowedError" ||
          err.message.includes("cancelled")
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
    clearStoredCredential();
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
