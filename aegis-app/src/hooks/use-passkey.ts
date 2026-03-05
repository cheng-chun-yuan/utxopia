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
  } catch {
    // ignore
  }
}

/**
 * Extract PRF output from WebAuthn credential response.
 * Returns 32-byte Uint8Array seed.
 */
function extractPrfOutput(
  extensions: AuthenticationExtensionsClientOutputs | undefined,
): Uint8Array {
  if (!extensions) throw new Error("No extensions in credential response");

  const prf = (extensions as Record<string, unknown>).prf as
    | { results?: { first?: ArrayBuffer } }
    | undefined;
  if (!prf?.results?.first) {
    throw new Error(
      "PRF extension not supported by this browser/authenticator. " +
        "Please use Chrome 116+, Safari 18+, or Android Chrome 132+.",
    );
  }

  // Hash PRF output to get exactly 32 bytes
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

      const seed = extractPrfOutput(credential.clientExtensionResults);

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

      const seed = extractPrfOutput(credential.clientExtensionResults);

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
