"use client";

import { useState, useCallback, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from "@solana/spl-token";
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

/** Stealth data: version(1) + viewingPubKey(32) + mpk(32) = 65 bytes */
const STEALTH_DATA_SIZE = 65;

/** Current stealth data version */
const STEALTH_DATA_VERSION = 2;

/** Bonfida fee owner (constant across networks) */
const BONFIDA_FEE_OWNER = new PublicKey("5D2zKog251d6KPCyFyLMt3KroWwXXPWSgTPyhV22K2gR");

/** SNS hash prefix used for PDA derivation */
const HASH_PREFIX = "SPL Name Service";

interface UseSnsNameReturn {
  registeredSnsName: string | null;
  hasRegisteredSnsName: boolean;
  needsUpdate: boolean;
  isLoading: boolean;
  isRegistering: boolean;
  error: string | null;
  lookupMySnsName: () => Promise<void>;
  lookupSnsName: (name: string) => Promise<SnsStealthAddress | null>;
  registerSnsSubdomain: (name: string) => Promise<boolean>;
  updateSnsStealthData: () => Promise<boolean>;
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
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [registeredSubdomainKey, setRegisteredSubdomainKey] = useState<PublicKey | null>(null);
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
          const ourViewing = Buffer.from(stealthAddress.viewingPubKey).toString("hex");
          const foundViewing = Buffer.from(parsed.viewingPubKey).toString("hex");

          if (ourViewing === foundViewing) {
            setHasRegisteredSnsName(true);
            setRegisteredSubdomainKey(account.pubkey);

            // Detect if record needs update (legacy format, zero mpk, or stale mpk)
            const mpkAllZero = parsed.mpk.every((b: number) => b === 0);
            const isOldVersion = parsed.version !== STEALTH_DATA_VERSION;
            const ourMpk = Buffer.from(stealthAddress.mpk).toString("hex");
            const foundMpk = Buffer.from(parsed.mpk).toString("hex");
            const mpkMismatch = ourMpk !== foundMpk;
            setNeedsUpdate(mpkAllZero || isOldVersion || mpkMismatch);

            // Reverse lookup: derive reverse key from subdomain account key
            const reverseLookupClass = new PublicKey(config.snsReverseLookupClass);
            const parentPubkey = new PublicKey(parentKey);
            const reverseHash = sha256Hash(
              new TextEncoder().encode(HASH_PREFIX + account.pubkey.toBase58())
            );
            const [reverseKey] = PublicKey.findProgramAddressSync(
              [reverseHash, reverseLookupClass.toBytes(), parentPubkey.toBytes()],
              nameServiceProgramId,
            );
            const reverseAcct = await connection.getAccountInfo(reverseKey);
            if (reverseAcct && reverseAcct.data.length > 100) {
              // SNS header(96) + borsh string(u32 len + bytes)
              const nameLen = reverseAcct.data.readUInt32LE(96);
              const rawName = reverseAcct.data.slice(100, 100 + nameLen).toString().replace(/\0/g, "").trim();
              if (rawName) {
                setRegisteredSnsName(rawName);
                setIsLoading(false);
                return;
              }
            }
            setRegisteredSnsName(null);
            setIsLoading(false);
            return;
          }
        }
      }

      setHasRegisteredSnsName(false);
      setNeedsUpdate(false);
      setRegisteredSubdomainKey(null);
      setRegisteredSnsName(null);
    } catch (err) {
      console.error("Failed to lookup SNS name:", err);
      setError("Failed to check SNS name registration");
    } finally {
      setIsLoading(false);
    }
  }, [wallet.publicKey, stealthAddress, connection]);

  // Register a new subdomain + write stealth data (2-transaction flow)
  // TX1: Register via Bonfida sub-registrar (creates subdomain + reverse lookup)
  // TX2: Realloc + write stealth data (combined into one TX)
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
      const snsRegistrarProgramId = new PublicKey(config.snsRegistrarProgramId);
      const rootDomain = new PublicKey(config.snsRootDomain);

      // Derive parent domain key
      const parentKey = await deriveParentDomainKey(config.snsParentDomain);
      const parentPubkey = new PublicKey(parentKey);

      // Derive subdomain key: hash("\0" + name) under parent
      const hashedSub = sha256Hash(new TextEncoder().encode(HASH_PREFIX + "\0" + subdomain));
      const [subdomainKey] = PublicKey.findProgramAddressSync(
        [hashedSub, new Uint8Array(32), parentPubkey.toBytes()],
        nameServiceProgramId,
      );

      // Derive reverse lookup key: hash(subdomainKey.base58) under [reverseLookupClass, parent]
      const reverseLookupClass = new PublicKey(config.snsReverseLookupClass);
      const reverseHash = sha256Hash(new TextEncoder().encode(HASH_PREFIX + subdomainKey.toBase58()));
      const [reverseKey] = PublicKey.findProgramAddressSync(
        [reverseHash, reverseLookupClass.toBytes(), parentPubkey.toBytes()],
        nameServiceProgramId,
      );

      // Derive registrar PDA: ["registrar", parentDomainKey]
      const [registrar] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("registrar"), parentPubkey.toBytes()],
        subRegistrarProgramId,
      );

      // Derive sub-record PDA: ["subrecord", subdomainKey]
      const [subRecord] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("subrecord"), subdomainKey.toBytes()],
        subRegistrarProgramId,
      );

      // Fetch registrar state to get mint and fee account
      const registrarAcct = await connection.getAccountInfo(registrar);
      if (!registrarAcct) {
        setError("Sub-registrar not initialized for this domain");
        return false;
      }
      // Registrar layout: tag(1) + nonce(1) + authority(32) + feeAccount(32) + mint(32) + domain(32) + ...
      const feeAccount = new PublicKey(registrarAcct.data.slice(34, 66));
      const mint = new PublicKey(registrarAcct.data.slice(66, 98));

      // Buyer's token account for the registration fee (wSOL)
      const feeSource = getAssociatedTokenAddressSync(mint, wallet.publicKey, true);

      // Bonfida fee account
      const bonfidaFee = getAssociatedTokenAddressSync(mint, BONFIDA_FEE_OWNER, true);

      // === TX1: Register subdomain via Bonfida sub-registrar ===
      const ixs: TransactionInstruction[] = [];

      // Ensure buyer's wSOL ATA exists and has enough balance for registration fee
      const WSOL_WRAP_AMOUNT = 10_000_000; // 0.01 SOL — enough for any registration fee
      const feeSourceAcct = await connection.getAccountInfo(feeSource);
      let needsWrap = true;
      if (feeSourceAcct && feeSourceAcct.data.length >= 72) {
        // SPL Token account: amount is u64 LE at offset 64
        const balance = new DataView(feeSourceAcct.data.buffer, feeSourceAcct.data.byteOffset).getBigUint64(64, true);
        if (balance >= BigInt(WSOL_WRAP_AMOUNT)) {
          needsWrap = false;
        }
      }

      if (needsWrap) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          feeSource,
          wallet.publicKey,
          NATIVE_MINT,
        ));
        ixs.push(SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: feeSource,
          lamports: WSOL_WRAP_AMOUNT,
        }));
        ixs.push(createSyncNativeInstruction(feeSource));
      }

      // Ensure Bonfida fee ATA exists
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        bonfidaFee,
        BONFIDA_FEE_OWNER,
        mint,
      ));

      // Sub-registrar register instruction: tag(1=2) + domain(borsh string: len_u32 + "\0" + name)
      const domainStr = "\0" + subdomain;
      const domainBytes = new TextEncoder().encode(domainStr);
      const registerData = new Uint8Array(1 + 4 + domainBytes.length);
      registerData[0] = 2; // discriminator: register
      new DataView(registerData.buffer).setUint32(1, domainBytes.length, true);
      registerData.set(domainBytes, 5);

      ixs.push(new TransactionInstruction({
        programId: subRegistrarProgramId,
        keys: [
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: nameServiceProgramId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: snsRegistrarProgramId, isSigner: false, isWritable: false },
          { pubkey: rootDomain, isSigner: false, isWritable: false },
          { pubkey: reverseLookupClass, isSigner: false, isWritable: false },
          { pubkey: feeAccount, isSigner: false, isWritable: true },
          { pubkey: feeSource, isSigner: false, isWritable: true },
          { pubkey: registrar, isSigner: false, isWritable: true },
          { pubkey: parentPubkey, isSigner: false, isWritable: true },
          { pubkey: subdomainKey, isSigner: false, isWritable: true },
          { pubkey: reverseKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: bonfidaFee, isSigner: false, isWritable: true },
          { pubkey: subRecord, isSigner: false, isWritable: true },
        ],
        data: Buffer.from(registerData),
      }));

      // Close wSOL ATA after registration to reclaim rent + unused wSOL (only if we created it)
      if (needsWrap) {
        ixs.push(createCloseAccountInstruction(
          feeSource,
          wallet.publicKey,
          wallet.publicKey,
        ));
      }

      // === Realloc + Write stealth data (appended to same TX) ===
      const reallocData = new Uint8Array(5);
      reallocData[0] = SNS_DISC_REALLOC;
      new DataView(reallocData.buffer).setUint32(1, STEALTH_DATA_SIZE, true);

      ixs.push(new TransactionInstruction({
        programId: nameServiceProgramId,
        keys: [
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: subdomainKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(reallocData),
      }));

      const stealthData = new Uint8Array(STEALTH_DATA_SIZE);
      stealthData[0] = STEALTH_DATA_VERSION;
      stealthData.set(stealthAddress.viewingPubKey, 1);
      stealthData.set(stealthAddress.mpk, 33);

      const updateData = new Uint8Array(1 + 4 + 4 + stealthData.length);
      updateData[0] = SNS_DISC_UPDATE;
      new DataView(updateData.buffer).setUint32(1, 0, true);
      new DataView(updateData.buffer).setUint32(5, stealthData.length, true);
      updateData.set(stealthData, 9);

      ixs.push(new TransactionInstruction({
        programId: nameServiceProgramId,
        keys: [
          { pubkey: subdomainKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(updateData),
      }));

      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet.publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signed = await wallet.signTransaction(tx);
      const txid = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`[SNS] Subdomain registered with stealth data (tx: ${txid})`);

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

  // Update existing SNS record with new stealth data format
  const updateSnsStealthData = useCallback(async (): Promise<boolean> => {
    if (!wallet.publicKey || !wallet.signTransaction || !stealthAddress || !registeredSubdomainKey) {
      setError("Wallet not connected or no existing registration found");
      return false;
    }

    const config = getConfig();
    if (!config.snsNameServiceProgramId) {
      setError("SNS not configured");
      return false;
    }

    setIsRegistering(true);
    setError(null);

    try {
      const nameServiceProgramId = new PublicKey(config.snsNameServiceProgramId);
      const ixs: TransactionInstruction[] = [];

      // Realloc to new size (65 bytes — may shrink from 97)
      const reallocData = new Uint8Array(5);
      reallocData[0] = SNS_DISC_REALLOC;
      new DataView(reallocData.buffer).setUint32(1, STEALTH_DATA_SIZE, true);

      ixs.push(new TransactionInstruction({
        programId: nameServiceProgramId,
        keys: [
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: registeredSubdomainKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(reallocData),
      }));

      // Write new stealth data: version(2) + viewingPubKey(32) + mpk(32)
      const stealthData = new Uint8Array(STEALTH_DATA_SIZE);
      stealthData[0] = STEALTH_DATA_VERSION;
      stealthData.set(stealthAddress.viewingPubKey, 1);
      stealthData.set(stealthAddress.mpk, 33);

      const updateData = new Uint8Array(1 + 4 + 4 + stealthData.length);
      updateData[0] = SNS_DISC_UPDATE;
      new DataView(updateData.buffer).setUint32(1, 0, true);
      new DataView(updateData.buffer).setUint32(5, stealthData.length, true);
      updateData.set(stealthData, 9);

      ixs.push(new TransactionInstruction({
        programId: nameServiceProgramId,
        keys: [
          { pubkey: registeredSubdomainKey, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(updateData),
      }));

      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet.publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const signed = await wallet.signTransaction(tx);
      const txid = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`[SNS] Stealth data updated to v2 format (tx: ${txid})`);

      setNeedsUpdate(false);
      return true;
    } catch (err) {
      console.error("Failed to update SNS stealth data:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage || "Failed to update stealth data");
      return false;
    } finally {
      setIsRegistering(false);
    }
  }, [wallet, stealthAddress, connection, registeredSubdomainKey]);

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
    needsUpdate,
    isLoading,
    isRegistering,
    error,
    lookupMySnsName,
    lookupSnsName,
    registerSnsSubdomain,
    updateSnsStealthData,
  };
}
