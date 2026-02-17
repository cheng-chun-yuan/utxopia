"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, TransactionInstruction, Transaction } from "@solana/web3.js";
import { useZVaultKeys } from "./use-zvault";

// Import all name registry functions from SDK (single source of truth)
import {
  DEVNET_CONFIG,
  hashName,
  isValidName,
  normalizeName,
  formatZkeyName,
  getNameValidationError,
  parseNameRegistry as sdkParseNameRegistry,
  parseReverseRegistry,
  buildRegisterNameData as sdkBuildRegisterNameData,
  NAME_REGISTRY_SEED,
  REVERSE_REGISTRY_SEED,
  NAME_REGISTRY_DISCRIMINATOR,
  REVERSE_REGISTRY_DISCRIMINATOR,
  type NameRegistryEntry,
} from "@zvault/sdk";

// Program ID from SDK config
const PROGRAM_ID = new PublicKey(DEVNET_CONFIG.zvaultProgramId);

interface UseZkeyNameReturn {
  registeredName: string | null;
  hasRegisteredName: boolean;
  isLoading: boolean;
  isRegistering: boolean;
  isCheckingAvailability: boolean;
  isNameTaken: boolean;
  error: string | null;
  lookupMyName: () => Promise<void>;
  registerName: (name: string) => Promise<boolean>;
  lookupName: (name: string) => Promise<NameRegistryEntry | null>;
  checkAvailability: (name: string) => Promise<boolean>;
  verifyMyName: (name: string) => Promise<boolean>;
  validateName: (name: string) => string | null;
  formatName: (name: string) => string;
}

/**
 * Hook for managing .zkey.sol name registration
 * Uses @zvault/sdk for all name registry operations
 */
export function useZkeyName(): UseZkeyNameReturn {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { stealthAddress } = useZVaultKeys();

  const [registeredName, setRegisteredName] = useState<string | null>(null);
  const [hasRegisteredName, setHasRegisteredName] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false);
  const [isNameTaken, setIsNameTaken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive PDA for a name (uses SDK's hashName)
  const deriveNamePDA = useCallback((name: string): [PublicKey, number] => {
    const nameHash = hashName(name);
    return PublicKey.findProgramAddressSync(
      [Buffer.from(NAME_REGISTRY_SEED), Buffer.from(nameHash)],
      PROGRAM_ID
    );
  }, []);

  // Derive reverse registry PDA for a spending pubkey (SNS pattern)
  // Compress 33-byte key to 32 bytes (Solana PDA seed limit): first 32 bytes XOR'd with byte 33
  const deriveReversePDA = useCallback((spendingPubKey: Uint8Array): [PublicKey, number] => {
    const seed = new Uint8Array(32);
    seed.set(spendingPubKey.slice(0, 32));
    seed[0] ^= spendingPubKey[32]; // XOR the 33rd byte into first byte
    return PublicKey.findProgramAddressSync(
      [Buffer.from(REVERSE_REGISTRY_SEED), Buffer.from(seed)],
      PROGRAM_ID
    );
  }, []);

  // Look up a name on-chain
  const lookupName = useCallback(async (name: string): Promise<NameRegistryEntry | null> => {
    try {
      const normalized = normalizeName(name);
      if (!isValidName(normalized)) return null;

      const [pda] = deriveNamePDA(normalized);
      const accountInfo = await connection.getAccountInfo(pda);
      if (!accountInfo) return null;

      return sdkParseNameRegistry(new Uint8Array(accountInfo.data), normalized);
    } catch (err) {
      console.error("Failed to lookup name:", err);
      return null;
    }
  }, [connection, deriveNamePDA]);

  // Check availability
  const checkAvailability = useCallback(async (name: string): Promise<boolean> => {
    const normalized = normalizeName(name);
    if (!isValidName(normalized)) {
      setIsNameTaken(false);
      return true;
    }

    setIsCheckingAvailability(true);
    try {
      const existing = await lookupName(normalized);
      const taken = existing !== null;
      setIsNameTaken(taken);
      return !taken;
    } catch {
      setIsNameTaken(false);
      return true;
    } finally {
      setIsCheckingAvailability(false);
    }
  }, [lookupName]);

  // Look up if current wallet has a registered name using reverse lookup (SNS pattern)
  const lookupMyName = useCallback(async () => {
    if (!wallet.publicKey || !stealthAddress) return;

    setIsLoading(true);
    setError(null);

    try {
      // Use reverse lookup: spending_pubkey → name
      const [reversePDA] = deriveReversePDA(stealthAddress.spendingPubKey);
      const reverseAccount = await connection.getAccountInfo(reversePDA);

      if (reverseAccount && reverseAccount.data.length >= 68) {
        const data = new Uint8Array(reverseAccount.data);
        // Use SDK's parseReverseRegistry
        const name = parseReverseRegistry(data);
        if (name) {
          setRegisteredName(name);
          setHasRegisteredName(true);
          return;
        }
      }

      setHasRegisteredName(false);
      setRegisteredName(null);
    } catch (err) {
      console.error("Failed to lookup my name:", err);
      setError("Failed to check name registration");
    } finally {
      setIsLoading(false);
    }
  }, [wallet.publicKey, stealthAddress, connection, deriveReversePDA]);

  // Verify ownership of a specific name
  const verifyMyName = useCallback(async (name: string): Promise<boolean> => {
    if (!wallet.publicKey || !stealthAddress) return false;

    const normalized = normalizeName(name);
    if (!isValidName(normalized)) return false;

    try {
      const entry = await lookupName(normalized);
      if (!entry) return false;

      const entrySpendingHex = Buffer.from(entry.spendingPubKey).toString("hex");
      const ourSpendingHex = Buffer.from(stealthAddress.spendingPubKey).toString("hex");

      if (entrySpendingHex === ourSpendingHex) {
        setRegisteredName(normalized);
        setHasRegisteredName(true);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [wallet.publicKey, stealthAddress, lookupName]);

  // Register a new name
  const registerName = useCallback(async (name: string): Promise<boolean> => {
    if (!wallet.publicKey || !wallet.signTransaction || !stealthAddress) {
      setError("Wallet not connected or keys not derived");
      return false;
    }

    const normalized = normalizeName(name);
    const validationError = getNameValidationError(normalized);
    if (validationError) {
      setError(validationError);
      return false;
    }

    setIsRegistering(true);
    setError(null);

    try {
      // Check if taken
      const existing = await lookupName(normalized);
      if (existing) {
        setError(`Name "${formatZkeyName(normalized)}" is already registered`);
        return false;
      }

      // Build instruction using SDK function
      const instructionData = sdkBuildRegisterNameData(
        normalized,
        stealthAddress.spendingPubKey,
        stealthAddress.viewingPubKey
      );

      const [namePDA] = deriveNamePDA(normalized);
      const [reversePDA] = deriveReversePDA(stealthAddress.spendingPubKey);

      // Accounts: name_registry, reverse_registry, owner, system_program
      const instruction = new TransactionInstruction({
        keys: [
          { pubkey: namePDA, isSigner: false, isWritable: true },
          { pubkey: reversePDA, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data: Buffer.from(instructionData),
      });

      const transaction = new Transaction().add(instruction);
      transaction.feePayer = wallet.publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;

      const signed = await wallet.signTransaction(transaction);
      const txid = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const confirmation = await connection.confirmTransaction(
        { signature: txid, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      setRegisteredName(normalized);
      setHasRegisteredName(true);
      console.log(`[zkey.sol] Registered: ${formatZkeyName(normalized)} (tx: ${txid})`);
      return true;
    } catch (err) {
      console.error("Failed to register name:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage || "Failed to register name");
      return false;
    } finally {
      setIsRegistering(false);
    }
  }, [wallet, stealthAddress, connection, deriveNamePDA, deriveReversePDA, lookupName]);

  // Check for existing name on mount
  useEffect(() => {
    if (wallet.publicKey && stealthAddress) {
      lookupMyName();
    } else {
      setRegisteredName(null);
      setHasRegisteredName(false);
    }
  }, [wallet.publicKey, stealthAddress, lookupMyName]);

  return {
    registeredName,
    hasRegisteredName,
    isLoading,
    isRegistering,
    isCheckingAvailability,
    isNameTaken,
    error,
    lookupMyName,
    registerName,
    lookupName,
    checkAvailability,
    verifyMyName,
    validateName: getNameValidationError,
    formatName: formatZkeyName,
  };
}
