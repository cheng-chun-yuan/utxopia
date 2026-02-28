"use client";

import { useState, useCallback, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { useZVaultKeys } from "./use-zvault";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import {
  getConfig,
  resolveSnsName,
  parseSnsStealthData,
  deriveParentDomainKey,
  sha256Hash,
  type SnsStealthAddress,
} from "@zvault/sdk";

/** SPL Name Service instruction discriminators */
const SNS_DISC_UPDATE = 1;
const SNS_DISC_REALLOC = 4;

/** Stealth data: version(1) + spendingPubKey(32) + viewingPubKey(32) = 65 bytes */
const STEALTH_DATA_SIZE = 65;

interface UseSnsNameReturn {
  registeredSnsName: string | null;
  hasRegisteredSnsName: boolean;
  isLoading: boolean;
  isRegistering: boolean;
  error: string | null;
  lookupMySnsName: () => Promise<void>;
  lookupSnsName: (name: string) => Promise<SnsStealthAddress | null>;
  registerSnsSubdomain: (name: string) => Promise<boolean>;
}

/**
 * Hook for managing *.btcpro.sol SNS subdomain stealth addresses.
 *
 * Responsibilities:
 * - Auto-detect if connected wallet owns a *.btcpro.sol subdomain
 * - Resolve subdomain names to stealth keys
 * - Register new subdomains with stealth data (3-transaction flow)
 */
export function useSnsName(): UseSnsNameReturn {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { stealthAddress } = useZVaultKeys();

  const [registeredSnsName, setRegisteredSnsName] = useState<string | null>(null);
  const [hasRegisteredSnsName, setHasRegisteredSnsName] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve an SNS name to stealth keys
  const lookupSnsName = useCallback(async (name: string): Promise<SnsStealthAddress | null> => {
    const connectionAdapter = getConnectionAdapter();
    return resolveSnsName(connectionAdapter as any, name);
  }, []);

  // Check if connected wallet owns a *.btcpro.sol subdomain
  const lookupMySnsName = useCallback(async () => {
    if (!wallet.publicKey || !stealthAddress) return;

    const config = getConfig();
    if (!config.snsNameServiceProgramId || !config.snsParentDomain) return;

    setIsLoading(true);
    setError(null);

    try {
      // Get parent domain key for memcmp filter
      const parentKey = await deriveParentDomainKey(config.snsParentDomain);

      // Search for name accounts owned by this wallet under the parent domain
      const nameServiceProgramId = new PublicKey(config.snsNameServiceProgramId);
      const accounts = await connection.getProgramAccounts(nameServiceProgramId, {
        filters: [
          // parent field at offset 0 = parentKey (32 bytes)
          { memcmp: { offset: 0, bytes: parentKey } },
          // owner field at offset 32 = wallet pubkey (32 bytes)
          { memcmp: { offset: 32, bytes: wallet.publicKey.toBase58() } },
        ],
      });

      // Check each matched account for stealth data
      for (const account of accounts) {
        const parsed = parseSnsStealthData(new Uint8Array(account.account.data));
        if (parsed) {
          // Found a subdomain with stealth data - we need to figure out the name
          // Try common approach: check if the stealth keys match ours
          const ourSpending = Buffer.from(stealthAddress.spendingPubKey).toString("hex");
          const foundSpending = Buffer.from(parsed.spendingPubKey).toString("hex");

          if (ourSpending === foundSpending) {
            // This is our subdomain. We don't know the name from the account data alone,
            // so we store the account key and mark as found.
            // The name can be discovered by trying known names or storing it.
            setHasRegisteredSnsName(true);
            // For now, we can't reverse-lookup the name from SNS accounts.
            // We'll set it when registration happens or if we find it.
            setRegisteredSnsName(null); // Name unknown from reverse lookup
            setIsLoading(false);
            return;
          }
        }
      }

      setHasRegisteredSnsName(false);
      setRegisteredSnsName(null);
    } catch (err) {
      console.error("Failed to lookup SNS name:", err);
      setError("Failed to check SNS name registration");
    } finally {
      setIsLoading(false);
    }
  }, [wallet.publicKey, stealthAddress, connection]);

  // Register a new subdomain + write stealth data (3-transaction flow)
  const registerSnsSubdomain = useCallback(async (name: string): Promise<boolean> => {
    if (!wallet.publicKey || !wallet.signTransaction || !stealthAddress) {
      setError("Wallet not connected or keys not derived");
      return false;
    }

    const config = getConfig();
    if (!config.snsSubRegistrarProgramId || !config.snsNameServiceProgramId) {
      setError("SNS not configured for this network");
      return false;
    }

    const subdomain = name.trim().toLowerCase();
    if (!subdomain || subdomain.includes(".") || subdomain.length > 32) {
      setError("Invalid subdomain name");
      return false;
    }

    setIsRegistering(true);
    setError(null);

    try {
      // Check if already exists
      const existing = await lookupSnsName(subdomain);
      if (existing) {
        setError(`"${subdomain}.${config.snsParentDomain}.sol" is already registered`);
        return false;
      }

      const nameServiceProgramId = new PublicKey(config.snsNameServiceProgramId);
      const subRegistrarProgramId = new PublicKey(config.snsSubRegistrarProgramId);

      // Derive parent domain key
      const parentKey = await deriveParentDomainKey(config.snsParentDomain);
      const parentPubkey = new PublicKey(parentKey);

      // Derive subdomain key using SNS hashing
      const HASH_PREFIX = "SPL Name Service";
      const hashedSub = sha256Hash(new TextEncoder().encode(HASH_PREFIX + "\0" + subdomain));

      // Derive subdomain PDA
      const [subdomainKey] = PublicKey.findProgramAddressSync(
        [hashedSub, new Uint8Array(32), parentPubkey.toBytes()],
        nameServiceProgramId,
      );

      // Derive sub-registrar state PDA
      const [subRegistrarState] = PublicKey.findProgramAddressSync(
        [parentPubkey.toBytes()],
        subRegistrarProgramId,
      );

      // === TX1: Register subdomain via sub-registrar ===
      // Sub-registrar register instruction: disc(1)=0 + nameLen(u32 LE) + name
      const nameBytes = new TextEncoder().encode(subdomain);
      const registerData = new Uint8Array(1 + 4 + nameBytes.length);
      registerData[0] = 0; // discriminator: register
      new DataView(registerData.buffer).setUint32(1, nameBytes.length, true);
      registerData.set(nameBytes, 5);

      const registerIx = new TransactionInstruction({
        programId: subRegistrarProgramId,
        keys: [
          { pubkey: nameServiceProgramId, isSigner: false, isWritable: false },
          { pubkey: subdomainKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: parentPubkey, isSigner: false, isWritable: false },
          { pubkey: subRegistrarState, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(registerData),
      });

      const tx1 = new Transaction().add(registerIx);
      tx1.feePayer = wallet.publicKey;
      const { blockhash: bh1, lastValidBlockHeight: lvbh1 } = await connection.getLatestBlockhash();
      tx1.recentBlockhash = bh1;

      const signed1 = await wallet.signTransaction(tx1);
      const txid1 = await connection.sendRawTransaction(signed1.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature: txid1, blockhash: bh1, lastValidBlockHeight: lvbh1 }, "confirmed");
      console.log(`[SNS] Subdomain registered: ${subdomain} (tx: ${txid1})`);

      // === TX2: Realloc name account to hold stealth data ===
      // Realloc instruction: disc(1)=4 + space(u32 LE)
      const reallocData = new Uint8Array(5);
      reallocData[0] = SNS_DISC_REALLOC;
      new DataView(reallocData.buffer).setUint32(1, STEALTH_DATA_SIZE, true);

      const reallocIx = new TransactionInstruction({
        programId: nameServiceProgramId,
        keys: [
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: subdomainKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(reallocData),
      });

      const tx2 = new Transaction().add(reallocIx);
      tx2.feePayer = wallet.publicKey;
      const { blockhash: bh2, lastValidBlockHeight: lvbh2 } = await connection.getLatestBlockhash();
      tx2.recentBlockhash = bh2;

      const signed2 = await wallet.signTransaction(tx2);
      const txid2 = await connection.sendRawTransaction(signed2.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature: txid2, blockhash: bh2, lastValidBlockHeight: lvbh2 }, "confirmed");
      console.log(`[SNS] Realloc to ${STEALTH_DATA_SIZE} bytes (tx: ${txid2})`);

      // === TX3: Write stealth data ===
      // Update instruction: disc(1)=1 + offset(u32 LE) + dataLen(u32 LE) + data
      const stealthData = new Uint8Array(STEALTH_DATA_SIZE);
      stealthData[0] = config.snsStealthDataVersion; // version
      stealthData.set(stealthAddress.spendingPubKey, 1);
      stealthData.set(stealthAddress.viewingPubKey, 33);

      const updateData = new Uint8Array(1 + 4 + 4 + stealthData.length);
      updateData[0] = SNS_DISC_UPDATE;
      new DataView(updateData.buffer).setUint32(1, 0, true); // offset = 0
      new DataView(updateData.buffer).setUint32(5, stealthData.length, true); // data length
      updateData.set(stealthData, 9);

      const updateIx = new TransactionInstruction({
        programId: nameServiceProgramId,
        keys: [
          { pubkey: subdomainKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(updateData),
      });

      const tx3 = new Transaction().add(updateIx);
      tx3.feePayer = wallet.publicKey;
      const { blockhash: bh3, lastValidBlockHeight: lvbh3 } = await connection.getLatestBlockhash();
      tx3.recentBlockhash = bh3;

      const signed3 = await wallet.signTransaction(tx3);
      const txid3 = await connection.sendRawTransaction(signed3.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature: txid3, blockhash: bh3, lastValidBlockHeight: lvbh3 }, "confirmed");
      console.log(`[SNS] Stealth data written (tx: ${txid3})`);

      setRegisteredSnsName(subdomain);
      setHasRegisteredSnsName(true);
      return true;
    } catch (err) {
      console.error("Failed to register SNS subdomain:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage || "Failed to register subdomain");
      return false;
    } finally {
      setIsRegistering(false);
    }
  }, [wallet, stealthAddress, connection, lookupSnsName]);

  // Auto-check on mount when wallet connected
  useEffect(() => {
    if (wallet.publicKey && stealthAddress) {
      lookupMySnsName();
    } else {
      setRegisteredSnsName(null);
      setHasRegisteredSnsName(false);
    }
  }, [wallet.publicKey, stealthAddress, lookupMySnsName]);

  return {
    registeredSnsName,
    hasRegisteredSnsName,
    isLoading,
    isRegistering,
    error,
    lookupMySnsName,
    lookupSnsName,
    registerSnsSubdomain,
  };
}
