"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { getConfig, computeTokenId, computeNPKSync, computeMPKSync } from "@aegis/sdk";
import { useAegis } from "@/hooks/use-aegis";
import { getRegisteredTokens, type TokenInfo } from "@/lib/token-context";
import { ed25519GenerateKeyPair, x25519Ecdh, ed25519PubToX25519 } from "@aegis/sdk";
import { Shield, ChevronDown, Loader2, ExternalLink, CheckCircle2, AlertCircle, LogOut, Wallet, Copy, Check, Zap, Info, RefreshCw, FileText, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import type { StealthMetaAddress } from "@aegis/sdk";
import {
  bytesToHex,
  hexToBytes,
  createStealthDepositWithKeys,
  createNonInteractiveDeposit,
  bigintToBytes,
  buildDepositPsbt,
  selectUtxos,
} from "@aegis/sdk";
import { SHIELD_TOKENS } from "@/lib/supported-tokens";
import { useBitcoinWalletStore, type WalletUtxo } from "@/stores/bitcoin-wallet-store";
import { useNotesStore } from "@/stores/notes-store";
import { registerDeposit } from "@/lib/api/deposits";
import { getBtcSignerNetwork, getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";
import { relayFetch } from "@/lib/api/relay-fetch";
import { Tooltip } from "@/components/ui/tooltip";
import { notifySuccess, notifyError } from "@/lib/notifications";
import { MobileWalletGuidance } from "@/components/bitcoin-wallet-selector";
import { useIsMobileWithoutWallet } from "@/hooks/use-mobile-wallet-detect";

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

interface ShieldFlowProps {
  className?: string;
}

type ShieldStatus = "idle" | "processing" | "done" | "error";

export function ShieldFlow({ className }: ShieldFlowProps) {
  const wallet = useWallet();
  const { publicKey, sendTransaction } = wallet;
  const { connection } = useConnection();
  const { setVisible: openWalletModal } = useWalletModal();
  const { keys, stealthAddress, stealthAddressEncoded } = useAegis();

  // Passkey users have keys but no Solana wallet — need to connect wallet for SPL shielding
  const isPasskeyOnly = !!keys && !publicKey;
  // Show all tokens for everyone — prompt wallet connection if needed for SPL
  const availableTokens = SHIELD_TOKENS;

  const [selectedToken, setSelectedToken] = useState(availableTokens[0]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [status, setStatus] = useState<ShieldStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [splBalance, setSplBalance] = useState<number | null>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── BTC-specific state ──
  const btcWallet = useBitcoinWalletStore();
  const isMobileNoWallet = useIsMobileWithoutWallet();
  const isDevnet = getConfig().network === "devnet" || getConfig().network === "localnet";
  const [demoMode, setDemoMode] = useState(false);
  const [demoAmount, setDemoAmount] = useState("");
  const [demoSubmitting, setDemoSubmitting] = useState(false);
  const [demoResult, setDemoResult] = useState<{ signature: string; ephemeralPubKey?: string } | null>(null);
  const [btcAmount, setBtcAmount] = useState("");
  const [walletDepositing, setWalletDepositing] = useState(false);
  const [walletDepositResult, setWalletDepositResult] = useState<{ txid: string; depositAddress: string; opReturnHex: string } | null>(null);
  const [depositPreview, setDepositPreview] = useState<{
    depositAddress: string;
    depositAmountSats: number;
    opReturnHex: string;
    opReturnPayload: Uint8Array;
    cachedUtxos: WalletUtxo[];
  } | null>(null);
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [selectedUtxoKeys, setSelectedUtxoKeys] = useState<Set<string>>(new Set());
  const [showUtxoList, setShowUtxoList] = useState(false);
  const [editingUtxos, setEditingUtxos] = useState(false);
  const [showOpReturn, setShowOpReturn] = useState(false);
  const [copiedBtcAddr, setCopiedBtcAddr] = useState(false);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const walletPickerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (walletPickerRef.current && !walletPickerRef.current.contains(e.target as Node)) {
        setShowWalletPicker(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Auto-resolve self stealth address as default recipient
  useEffect(() => {
    if (stealthAddress && !resolvedMeta) {
      setResolvedMeta(stealthAddress);
    }
  }, [stealthAddress, resolvedMeta]);

  // Fetch SOL balance when SOL is selected
  useEffect(() => {
    if (!publicKey || !selectedToken.isSOL) {
      setSolBalance(null);
      return;
    }
    let cancelled = false;
    connection.getBalance(publicKey).then((bal) => {
      if (!cancelled) setSolBalance(bal);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [publicKey, selectedToken.isSOL, connection]);

  // Fetch SPL token balance for non-SOL, non-BTC tokens (USDC, USDT, zkBTC)
  useEffect(() => {
    if (!publicKey || selectedToken.isSOL || selectedToken.isBtcNative || !selectedToken.mint) {
      setSplBalance(null);
      return;
    }
    let cancelled = false;
    const mintPubkey = new PublicKey(selectedToken.mint || getConfig().zkbtcMint);
    connection.getTokenAccountsByOwner(publicKey, {
      mint: mintPubkey,
      programId: TOKEN_2022_PROGRAM_ID,
    }).then((accounts) => {
      if (cancelled) return;
      if (accounts.value.length === 0) { setSplBalance(0); return; }
      // Parse token amount from account data (offset 64, 8 bytes LE u64)
      const data = accounts.value[0].account.data;
      const view = new DataView(data.buffer, data.byteOffset + 64, 8);
      setSplBalance(Number(view.getBigUint64(0, true)));
    }).catch(() => { if (!cancelled) setSplBalance(0); });
    return () => { cancelled = true; };
  }, [publicKey, selectedToken, connection]);

  const handleMax = useCallback(() => {
    if (selectedToken.isBtcNative && btcWallet.balance !== null) {
      // Reserve ~1000 sats for fees
      const maxSats = Math.max(0, btcWallet.balance - 1000);
      setBtcAmount((maxSats / 1e8).toFixed(8));
    } else if (selectedToken.isSOL && solBalance !== null) {
      // Reserve ~0.01 SOL for tx fees
      const maxLamports = Math.max(0, solBalance - 0.01 * LAMPORTS_PER_SOL);
      setAmount((maxLamports / LAMPORTS_PER_SOL).toFixed(9));
    } else if (!selectedToken.isSOL && !selectedToken.isBtcNative && splBalance !== null) {
      const value = splBalance / (10 ** selectedToken.decimals);
      setAmount(value.toFixed(selectedToken.decimals));
    } else {
      setAmount("0");
    }
  }, [selectedToken, solBalance, splBalance, btcWallet.balance]);

  // ── BTC: Reset flow ──
  const resetBtcFlow = useCallback(() => {
    setError(null);
    setResolvedMeta(stealthAddress ?? null);
    setBtcAmount("");
    setDemoResult(null);
    setWalletDepositResult(null);
    setDepositPreview(null);
  }, [stealthAddress]);

  // ── BTC Demo: Submit mock stealth deposit ──
  const submitDemoDeposit = useCallback(async () => {
    if (!resolvedMeta) { notifyError("Please resolve recipient first"); return; }
    const sats = Math.floor(parseFloat(btcAmount || "0") * 1e8);
    if (sats <= 0) { notifyError("Amount must be positive"); return; }

    setDemoSubmitting(true);
    setDemoResult(null);
    setError(null);

    try {
      const { getActiveTokenId } = await import("@/lib/token-context");
      const stealthData = await createStealthDepositWithKeys(resolvedMeta, BigInt(sats), getActiveTokenId());
      const npkBytes = bigintToBytes(stealthData.stealthPubKeyX);

      const response = await relayFetch("/api/demo", {
        method: "POST",
        body: JSON.stringify({
          ephemeralPub: bytesToHex(stealthData.ephemeralPub),
          npk: bytesToHex(npkBytes),
          amount: sats.toString(),
        }),
      });

      const result = await response.json();
      if (!result.success) throw new Error(result.error || "Failed to submit demo deposit");

      setDemoResult({ signature: result.signature, ephemeralPubKey: bytesToHex(stealthData.ephemeralPub) });
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit demo deposit");
      setStatus("error");
    } finally {
      setDemoSubmitting(false);
    }
  }, [resolvedMeta, btcAmount]);

  // ── BTC Real: Build PSBT preview ──
  const buildTxPreview = useCallback(async () => {
    if (!resolvedMeta || !btcWallet.connected) return;
    const amountSats = Math.floor(parseFloat(btcAmount || "0") * 1e8);
    if (!amountSats || amountSats < 546) { notifyError("Amount must be at least 546 sats"); return; }

    setBuildingPreview(true);
    setError(null);
    setDepositPreview(null);

    try {
      const config = getConfig();
      const groupPubKey = hexToBytes(config.groupPubKey);

      const [deposit, utxos] = await Promise.all([
        createNonInteractiveDeposit(resolvedMeta, groupPubKey, getBtcSignerNetwork()),
        btcWallet.getPaymentUtxos(),
      ]);

      if (utxos.length === 0) throw new Error("No confirmed UTXOs available in wallet");

      const autoSelected = selectUtxos(
        utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex })),
        amountSats,
        2,
      );
      setSelectedUtxoKeys(new Set(autoSelected.map((u) => `${u.txid}:${u.vout}`)));
      setShowUtxoList(false);
      setEditingUtxos(false);

      setDepositPreview({
        depositAddress: deposit.btcAddress,
        depositAmountSats: amountSats,
        opReturnHex: bytesToHex(deposit.opReturnPayload),
        opReturnPayload: deposit.opReturnPayload,
        cachedUtxos: utxos,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate deposit");
    } finally {
      setBuildingPreview(false);
    }
  }, [resolvedMeta, btcAmount, btcWallet]);

  // ── BTC Real: Confirm & sign PSBT ──
  const confirmAndSign = useCallback(async () => {
    if (!depositPreview) return;
    setWalletDepositing(true);
    setError(null);

    try {
      const selected = depositPreview.cachedUtxos
        .filter((u) => selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
        .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex }));
      if (selected.length === 0) throw new Error("No UTXOs selected");

      const totalSelected = selected.reduce((sum, u) => sum + u.value, 0);
      if (totalSelected < depositPreview.depositAmountSats)
        throw new Error(`Selected UTXOs (${totalSelected} sats) insufficient for deposit (${depositPreview.depositAmountSats} sats)`);

      const psbtResult = buildDepositPsbt({
        senderUtxos: selected,
        depositAddress: depositPreview.depositAddress,
        depositAmountSats: depositPreview.depositAmountSats,
        opReturnPayload: depositPreview.opReturnPayload,
        changeAddress: btcWallet.address!,
        feeRate: 2,
        network: getBtcSignerNetwork(),
      });

      const { txid } = await btcWallet.signAndBroadcastPsbt(psbtResult.psbtBase64);

      const opReturnHex = depositPreview.opReturnHex;
      useNotesStore.getState().saveNote({
        commitment: opReturnHex,
        noteExport: txid,
        amountSats: depositPreview.depositAmountSats,
        taprootAddress: depositPreview.depositAddress,
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
      });

      // Register with backend (fire-and-forget with retry)
      const ephemeralPubHex = opReturnHex.slice(0, 64);
      const npkHex = opReturnHex.slice(64);
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await registerDeposit(depositPreview.depositAddress, npkHex, depositPreview.depositAmountSats, ephemeralPubHex);
            if (res.deposit_id) useNotesStore.getState().updateNote(opReturnHex, { depositId: res.deposit_id });
            return;
          } catch (err) {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            else notifyError("Failed to register deposit with backend. Your deposit may not be tracked automatically.");
          }
        }
      })();

      setWalletDepositResult({ txid, depositAddress: depositPreview.depositAddress, opReturnHex });
      setDepositPreview(null);
      btcWallet.refreshBalance();
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet deposit failed");
      setStatus("error");
    } finally {
      setWalletDepositing(false);
    }
  }, [depositPreview, selectedUtxoKeys, btcWallet]);

  const handleShield = useCallback(async () => {
    if (!publicKey || !keys || !amount || !resolvedMeta) return;

    try {
      setStatus("processing");
      setError(null);

      const config = getConfig();
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * (10 ** selectedToken.decimals)));

      const ephemeral = ed25519GenerateKeyPair();
      const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);
      const viewingPubX25519 = ed25519PubToX25519(keys.viewingPubKey);
      const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubX25519);

      const { sha256 } = await import("@noble/hashes/sha2.js");
      const domain = new TextEncoder().encode("Aegis-stealth-v1");
      const secretBuf = new Uint8Array(sharedSecret.length + domain.length);
      secretBuf.set(sharedSecret);
      secretBuf.set(domain, sharedSecret.length);
      const hash = sha256(secretBuf);
      let stealthScalar = 0n;
      for (const b of hash) {
        stealthScalar = (stealthScalar << 8n) | BigInt(b);
      }
      const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      stealthScalar = stealthScalar % BN254_FIELD;

      const npk = computeNPKSync(mpk, stealthScalar);

      const npkBytes = new Uint8Array(32);
      let n = npk;
      for (let i = 31; i >= 0; i--) {
        npkBytes[i] = Number(n & 0xffn);
        n >>= 8n;
      }

      // Determine mint: SOL uses NATIVE_MINT_2022, others use zkBTC mint for now
      const mintPubkey = selectedToken.isSOL
        ? NATIVE_MINT_2022
        : selectedToken.mint
          ? new PublicKey(selectedToken.mint)
          : new PublicKey(config.zkbtcMint);

      const programId = new PublicKey(config.aegisProgramId);

      const [tokenConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_config"), mintPubkey.toBuffer()],
        programId,
      );
      const [poolStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_state")],
        programId,
      );
      const [commitmentTreePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("commitment_tree")],
        programId,
      );

      const tx = new Transaction();
      let userTokenAccount: PublicKey;

      if (selectedToken.isSOL) {
        // SOL shielding: wrap SOL → wSOL (Token-2022) → shield → close wSOL account
        const wsolAta = getAssociatedTokenAddressSync(
          NATIVE_MINT_2022,
          publicKey,
          false,
          SPL_TOKEN_2022_PROGRAM_ID,
        );

        // 1. Create wSOL ATA if needed (idempotent)
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            wsolAta,
            publicKey,
            NATIVE_MINT_2022,
            SPL_TOKEN_2022_PROGRAM_ID,
          ),
        );

        // 2. Transfer SOL → wSOL ATA
        tx.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: wsolAta,
            lamports: Number(amountRaw),
          }),
        );

        // 3. Sync native balance
        tx.add(
          createSyncNativeInstruction(wsolAta, SPL_TOKEN_2022_PROGRAM_ID),
        );

        userTokenAccount = wsolAta;

        // Read vault from TokenConfig PDA on-chain
        const tokenConfigAccount = await connection.getAccountInfo(tokenConfigPda);
        if (!tokenConfigAccount) {
          throw new Error("SOL token not registered on-chain. Admin must register wSOL (NATIVE_MINT_2022) first.");
        }
        // vault is at offset 66..98 in TokenConfig (disc:1 + bump:1 + mint:32 + tokenId:32 = 66)
        const vaultBytes = tokenConfigAccount.data.slice(66, 98);
        const vaultPubkey = new PublicKey(vaultBytes);

        // 4. Shield instruction
        const ixData = new Uint8Array(73);
        ixData[0] = 29;
        const dataView = new DataView(ixData.buffer);
        dataView.setBigUint64(1, amountRaw, true);
        ixData.set(npkBytes, 9);
        ixData.set(ephemeral.pubKey, 41);

        tx.add(new TransactionInstruction({
          programId,
          data: Buffer.from(ixData),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolStatePda, isSigner: false, isWritable: false },
            { pubkey: tokenConfigPda, isSigner: false, isWritable: true },
            { pubkey: vaultPubkey, isSigner: false, isWritable: true },
            { pubkey: commitmentTreePda, isSigner: false, isWritable: true },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
        }));

        // 5. Close wSOL account to reclaim rent (returns leftover SOL to user)
        tx.add(
          createCloseAccountInstruction(wsolAta, publicKey, publicKey, [], SPL_TOKEN_2022_PROGRAM_ID),
        );
      } else {
        // SPL token shielding (zkBTC, USDC, etc.)
        const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
          mint: mintPubkey,
          programId: TOKEN_2022_PROGRAM_ID,
        });

        if (tokenAccounts.value.length === 0) {
          throw new Error(`No ${selectedToken.symbol} token account found. Create one first.`);
        }
        userTokenAccount = tokenAccounts.value[0].pubkey;

        // Read vault from TokenConfig PDA (same approach as SOL path)
        const tokenConfigAccount = await connection.getAccountInfo(tokenConfigPda);
        if (!tokenConfigAccount) {
          throw new Error(`${selectedToken.symbol} token not registered on-chain. Admin must register it first.`);
        }
        // vault is at offset 66..98 in TokenConfig (disc:1 + bump:1 + mint:32 + tokenId:32 = 66)
        const vaultBytes = tokenConfigAccount.data.slice(66, 98);
        const vaultPubkey = new PublicKey(vaultBytes);

        const ixData = new Uint8Array(73);
        ixData[0] = 29;
        const dataView = new DataView(ixData.buffer);
        dataView.setBigUint64(1, amountRaw, true);
        ixData.set(npkBytes, 9);
        ixData.set(ephemeral.pubKey, 41);

        tx.add(new TransactionInstruction({
          programId,
          data: Buffer.from(ixData),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolStatePda, isSigner: false, isWritable: false },
            { pubkey: tokenConfigPda, isSigner: false, isWritable: true },
            { pubkey: vaultPubkey, isSigner: false, isWritable: true },
            { pubkey: commitmentTreePda, isSigner: false, isWritable: true },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
        }));
      }

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      setTxSig(sig);
      setStatus("done");
    } catch (err: any) {
      setError(err.message || "Shield failed");
      setStatus("error");
    }
  }, [publicKey, keys, selectedToken, amount, resolvedMeta, connection, sendTransaction]);

  const canSubmit = !!amount && parseFloat(amount) > 0 && !!resolvedMeta && !!publicKey && !!keys;

  // Success state
  if (status === "done") {
    const isBtc = selectedToken.isBtcNative;
    const resetDone = () => {
      setStatus("idle");
      setAmount("");
      setBtcAmount("");
      setTxSig(null);
      setDemoResult(null);
      setWalletDepositResult(null);
    };

    return (
      <div className={cn("space-y-4 text-center py-6", className)}>
        <div className={cn("inline-flex p-3 rounded-full border", isBtc ? "bg-btc/10 border-btc/20" : "bg-privacy/10 border-privacy/20")}>
          <CheckCircle2 className={cn("w-8 h-8", isBtc ? "text-btc" : "text-privacy")} />
        </div>
        <h3 className="text-lg font-semibold text-foreground">
          {isBtc ? "BTC Shielded!" : "Tokens Shielded!"}
        </h3>
        <p className="text-caption text-gray">
          {isBtc && demoResult
            ? "Demo deposit committed on-chain. Scan your wallet to see it."
            : isBtc && walletDepositResult
              ? "Your BTC deposit has been broadcast. The backend will automatically detect, sweep, and verify it."
              : `Your ${selectedToken.symbol} tokens are now private commitments.`}
        </p>
        {/* SPL tx link */}
        {txSig && (
          <a
            href={getSolanaExplorerTxUrl(txSig)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-caption text-sol hover:text-sol/80 transition-colors"
          >
            View transaction <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {/* BTC demo tx link */}
        {demoResult?.signature && (
          <a
            href={getSolanaExplorerTxUrl(demoResult.signature)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-caption text-sol hover:text-sol/80 transition-colors"
          >
            View on Solana <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {/* BTC real tx link */}
        {walletDepositResult?.txid && (
          <a
            href={`${getMempoolExplorerUrl()}/tx/${walletDepositResult.txid}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-caption text-btc hover:text-btc/80 transition-colors"
          >
            View on mempool.space <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <button
          onClick={resetDone}
          className="px-5 py-2 rounded-[10px] bg-muted border border-gray/15 text-body2 text-gray-light hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
        >
          Shield more
        </button>
      </div>
    );
  }

  // Token selector dropdown — shared across both flows
  const tokenSelector = (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-background/60 border border-gray/15 hover:border-gray/30 transition-colors cursor-pointer"
      >
        <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-5 h-5 rounded-full" />
        <span className="text-sm font-semibold text-foreground">{selectedToken.symbol}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 text-gray transition-transform", dropdownOpen && "rotate-180")} />
      </button>
      {dropdownOpen && (
        <div className="absolute right-0 top-full mt-1 w-[200px] bg-card border border-gray/20 rounded-[12px] shadow-xl z-50 overflow-hidden">
          {availableTokens.map((token) => (
            <button
              key={token.symbol}
              onClick={() => { setSelectedToken(token); setDropdownOpen(false); }}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer",
                selectedToken.symbol === token.symbol && "bg-privacy/5"
              )}
            >
              <img src={token.logo} alt={token.symbol} className="w-5 h-5 rounded-full" />
              <div className="flex-1 text-left">
                <div className="text-sm font-medium text-foreground">{token.symbol}</div>
                <div className="text-[10px] text-gray">{token.name}</div>
              </div>
              {token.isBtcNative && (
                <span className="px-1.5 py-0.5 rounded bg-btc/10 text-[8px] text-btc font-semibold uppercase">Native</span>
              )}
              {token.isSOL && (
                <span className="px-1.5 py-0.5 rounded bg-sol/10 text-[8px] text-sol font-semibold uppercase">Native</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // BTC native deposit flow — unified layout matching SPL flow
  if (selectedToken.isBtcNative) {
    const btcAmountSats = Math.floor(parseFloat(btcAmount || "0") * 1e8);
    const canSubmitBtc = btcAmountSats > 0 && !!resolvedMeta && !!keys;

    // PSBT preview active — show transaction details
    if (depositPreview) {
      const totalInput = depositPreview.cachedUtxos
        .filter((u) => selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
        .reduce((sum, u) => sum + u.value, 0);
      const estimatedVsize = selectedUtxoKeys.size * 68 + 78 + 43 + 43 + 12;
      const estimatedFee = estimatedVsize * 2;
      const changeAmount = totalInput - depositPreview.depositAmountSats - estimatedFee;
      const insufficientFunds = totalInput < depositPreview.depositAmountSats + estimatedFee;

      return (
        <div className={cn("space-y-3", className)}>
          {/* Inputs */}
          <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
            <div className="flex items-center justify-between">
              <p className="text-caption text-gray">
                Inputs ({selectedUtxoKeys.size} UTXO{selectedUtxoKeys.size !== 1 ? "s" : ""})
                <span className="text-foreground ml-1">{(totalInput / 1e8).toFixed(8)} BTC</span>
              </p>
              <div className="flex items-center gap-2">
                {showUtxoList && (
                  <button onClick={() => setEditingUtxos(!editingUtxos)} className={cn("text-[10px] transition-colors cursor-pointer", editingUtxos ? "text-warning hover:text-warning/80" : "text-sol hover:text-sol-light")}>
                    {editingUtxos ? "Done" : "Edit"}
                  </button>
                )}
                <button onClick={() => { setShowUtxoList(!showUtxoList); if (showUtxoList) setEditingUtxos(false); }} className="text-[10px] text-gray hover:text-gray-light transition-colors cursor-pointer">
                  {showUtxoList ? "Hide" : "Show UTXOs"}
                </button>
              </div>
            </div>
            {showUtxoList && (
              <div className="space-y-1.5 max-h-36 overflow-y-auto mt-2">
                {depositPreview.cachedUtxos.map((utxo) => {
                  const key = `${utxo.txid}:${utxo.vout}`;
                  const isSelected = selectedUtxoKeys.has(key);
                  if (!editingUtxos && !isSelected) return null;
                  return (
                    <div key={key} className={cn("flex items-center gap-2 p-2 rounded-[8px] transition-colors", editingUtxos ? "cursor-pointer" : "", isSelected ? "bg-btc/10 border border-btc/20" : "bg-background border border-gray/10 hover:border-gray/25")}
                      onClick={editingUtxos ? () => setSelectedUtxoKeys((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; }) : undefined}>
                      {editingUtxos && <input type="checkbox" checked={isSelected} readOnly className="accent-btc w-3.5 h-3.5 pointer-events-none" />}
                      <div className="flex-1 min-w-0"><code className="text-[10px] font-mono text-gray-light block truncate">{utxo.txid.slice(0, 8)}...:{utxo.vout}</code></div>
                      <span className="text-[11px] font-mono text-btc whitespace-nowrap">{(utxo.value / 1e8).toFixed(8)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Outputs divider */}
          <div className="flex items-center gap-2 px-1">
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
            <span className="text-[10px] text-gray/50 uppercase tracking-widest">Outputs</span>
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
          </div>

          {/* Deposit output */}
          <div className="p-3 bg-btc/5 border border-btc/20 rounded-[12px]">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-btc/15 flex items-center justify-center"><ArrowRight className="w-3 h-3 text-btc" /></div>
                <span className="text-caption font-semibold text-btc">Deposit</span>
              </div>
              <span className="text-[10px] font-mono bg-btc/10 text-btc/70 px-1.5 py-0.5 rounded">P2TR</span>
            </div>
            <p className="text-body2-semibold font-mono text-foreground">{(depositPreview.depositAmountSats / 1e8).toFixed(8)} BTC</p>
            <p className="text-caption text-gray mb-1.5">{depositPreview.depositAmountSats.toLocaleString()} sats</p>
            <div className="flex items-center gap-1.5 p-1.5 bg-background/50 rounded-[6px]">
              <code className="text-[10px] font-mono text-btc/60 truncate">{depositPreview.depositAddress.slice(0, 14)}...{depositPreview.depositAddress.slice(-14)}</code>
            </div>
          </div>

          {/* ZK Metadata (OP_RETURN) */}
          <div className="p-3 bg-privacy/5 border border-privacy/20 rounded-[12px]">
            <button onClick={() => setShowOpReturn(!showOpReturn)} className="w-full flex items-center justify-between cursor-pointer">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-privacy/15 flex items-center justify-center"><Shield className="w-3 h-3 text-privacy" /></div>
                <span className="text-caption font-semibold text-privacy">ZK Metadata</span>
                <span className="text-[10px] text-privacy/50">64 bytes</span>
              </div>
              <ChevronDown className={cn("w-3.5 h-3.5 text-gray transition-transform duration-200", showOpReturn && "rotate-180")} />
            </button>
            {showOpReturn && (
              <div className="mt-2 pt-2 border-t border-privacy/10 space-y-1.5">
                <div><p className="text-[10px] text-gray mb-0.5">Ephemeral Public Key</p><code className="block text-[9px] font-mono text-privacy/50 break-all leading-relaxed">{depositPreview.opReturnHex.slice(0, 64)}</code></div>
                <div><p className="text-[10px] text-gray mb-0.5">Note Public Key</p><code className="block text-[9px] font-mono text-privacy/50 break-all leading-relaxed">{depositPreview.opReturnHex.slice(64)}</code></div>
              </div>
            )}
          </div>

          {/* Change */}
          {changeAmount > 0 && (
            <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded-full bg-gray/15 flex items-center justify-center"><Wallet className="w-3 h-3 text-gray" /></div>
                <span className="text-caption font-semibold text-gray-light">Change</span>
              </div>
              <p className="text-body2-semibold font-mono text-foreground">{(changeAmount / 1e8).toFixed(8)} BTC</p>
              <p className="text-caption text-gray">{changeAmount.toLocaleString()} sats</p>
            </div>
          )}

          {/* Summary */}
          <div className="p-3 rounded-[12px] bg-muted border border-gray/15 space-y-1.5">
            <div className="flex items-center justify-between text-caption">
              <span className="text-gray">Deposit</span>
              <span className="font-mono text-btc">{(depositPreview.depositAmountSats / 1e8).toFixed(8)} BTC</span>
            </div>
            {changeAmount > 0 && (
              <div className="flex items-center justify-between text-caption">
                <span className="text-gray">Change</span>
                <span className="font-mono text-foreground">{(changeAmount / 1e8).toFixed(8)} BTC</span>
              </div>
            )}
            <div className="flex items-center justify-between text-caption">
              <span className="text-gray">Network Fee</span>
              <span className="font-mono text-foreground">{estimatedFee.toLocaleString()} sats</span>
            </div>
            <div className="flex items-center justify-between text-caption pt-1.5 border-t border-gray/10">
              <span className="text-gray-light font-medium">Total</span>
              <span className="font-mono text-foreground font-semibold">{((depositPreview.depositAmountSats + estimatedFee) / 1e8).toFixed(8)} BTC</span>
            </div>
          </div>

          {insufficientFunds && (
            <div className="p-2.5 bg-error/10 border border-error/20 rounded-[10px]">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-error shrink-0" />
                <span className="text-caption text-error">Insufficient funds. Select more UTXOs or reduce amount.</span>
              </div>
            </div>
          )}

          {/* Error */}
          {status === "error" && error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[10px]">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span className="text-caption text-red-400">{error}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <button onClick={() => setDepositPreview(null)} disabled={walletDepositing}
              className="flex-1 py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2 bg-muted hover:bg-gray/20 text-foreground border border-gray/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              Back
            </button>
            <button onClick={confirmAndSign} disabled={walletDepositing || insufficientFunds || selectedUtxoKeys.size === 0}
              className={cn("flex-[2] py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer",
                "bg-btc hover:bg-btc/90 text-background disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed")}>
              {walletDepositing ? (<><Loader2 className="w-4 h-4 animate-spin" />Signing...</>) : (<><Wallet className="w-4 h-4" />Confirm &amp; Sign</>)}
            </button>
          </div>
        </div>
      );
    }

    // Main BTC form — unified layout
    return (
      <div className={cn("space-y-5", className)}>
        {/* BTC Wallet bar + Demo toggle */}
        <div className="flex items-center justify-between gap-2">
          {btcWallet.connected ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <img src="/tokens/btc.png" alt="BTC" className="w-3.5 h-3.5 rounded-full shrink-0" />
              <code className="text-[11px] font-mono text-gray truncate">
                {btcWallet.address?.slice(0, 6)}...{btcWallet.address?.slice(-4)}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(btcWallet.address!); setCopiedBtcAddr(true); setTimeout(() => setCopiedBtcAddr(false), 1500); }}
                className="p-0.5 text-gray/30 hover:text-gray transition-colors cursor-pointer shrink-0" title="Copy address"
              >
                {copiedBtcAddr ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              </button>
              <button onClick={() => btcWallet.disconnect()} className="p-0.5 text-gray/30 hover:text-red-400 transition-colors cursor-pointer shrink-0" title="Disconnect">
                <LogOut className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div className="relative flex-1 min-w-0" ref={walletPickerRef}>
              {isMobileNoWallet ? (
                <MobileWalletGuidance />
              ) : (
                <>
                  <button
                    onClick={() => setShowWalletPicker(!showWalletPicker)}
                    disabled={btcWallet.connecting}
                    className="w-full py-2.5 rounded-[10px] font-semibold transition-all flex items-center justify-center gap-2 bg-btc/10 hover:bg-btc/20 text-btc border border-btc/25 disabled:opacity-50 cursor-pointer text-[13px]"
                  >
                    {btcWallet.connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wallet className="w-3.5 h-3.5" />}
                    Connect BTC Wallet
                    <ChevronDown className={cn("w-3 h-3 transition-transform", showWalletPicker && "rotate-180")} />
                  </button>
                  {showWalletPicker && (
                    <div className="absolute left-0 right-0 top-full mt-1.5 bg-card border border-gray/20 rounded-[12px] shadow-xl z-50 overflow-hidden">
                      <button
                        onClick={() => { btcWallet.connect("sats-connect"); setShowWalletPicker(false); }}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-btc/5 transition-colors cursor-pointer border-b border-gray/10"
                      >
                        <div className="w-8 h-8 rounded-full bg-btc/10 flex items-center justify-center">
                          <Wallet className="w-4 h-4 text-btc" />
                        </div>
                        <div className="text-left">
                          <div className="text-sm font-medium text-foreground">Xverse / Leather</div>
                          <div className="text-[10px] text-gray">Sats Connect compatible</div>
                        </div>
                      </button>
                      <button
                        onClick={() => { btcWallet.connect("unisat"); setShowWalletPicker(false); }}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-btc/5 transition-colors cursor-pointer"
                      >
                        <div className="w-8 h-8 rounded-full bg-btc/10 flex items-center justify-center">
                          <Wallet className="w-4 h-4 text-btc" />
                        </div>
                        <div className="text-left">
                          <div className="text-sm font-medium text-foreground">UniSat</div>
                          <div className="text-[10px] text-gray">Browser extension</div>
                        </div>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {/* Demo toggle inline */}
          {isDevnet && (
            <div className="flex items-center gap-1.5 shrink-0">
              <Zap className="w-3 h-3 text-warning" />
              <span className="text-[11px] text-warning/80">Demo</span>
              <Tooltip content="Skip BTC deposit — mock commitment on Solana">
                <Info className="w-3 h-3 text-warning/40" />
              </Tooltip>
              <button
                onClick={() => { setDemoMode(!demoMode); setDemoResult(null); }}
                className={cn("relative w-8 h-[18px] rounded-full transition-colors cursor-pointer ml-1", demoMode ? "bg-warning" : "bg-gray/30")}
                role="switch" aria-checked={demoMode}
              >
                <span className={cn("absolute top-[3px] left-[3px] w-3 h-3 rounded-full bg-white transition-transform", demoMode && "translate-x-3.5")} />
              </button>
            </div>
          )}
        </div>

        {/* Amount + Token selector */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-caption text-gray">Amount</span>
            <span className="text-caption text-gray/50">
              {btcWallet.connected && btcWallet.balance !== null
                ? `Balance: ${(btcWallet.balance / 1e8).toFixed(8)} BTC`
                : btcWallet.connected ? "Balance: loading..." : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 p-3 bg-muted border border-gray/15 rounded-[12px] focus-within:border-btc/30 transition-colors">
            <input
              type="number"
              value={btcAmount}
              onChange={(e) => setBtcAmount(e.target.value)}
              placeholder="0.00000000"
              step="0.00000001"
              className="flex-1 bg-transparent text-lg font-mono text-foreground placeholder:text-gray/30 outline-none min-w-0"
            />
            <button onClick={handleMax}
              className="px-2 py-1 rounded-[6px] bg-btc/10 border border-btc/20 text-[10px] font-semibold text-btc hover:bg-btc/20 transition-colors cursor-pointer uppercase tracking-wider">
              Max
            </button>
            {tokenSelector}
          </div>
          {btcAmount && (
            <p className="text-[10px] text-gray/50 pl-1">
              {btcAmountSats.toLocaleString()} sats
            </p>
          )}
        </div>

        {/* Recipient stealth address */}
        <StealthRecipientInput
          onResolved={(meta, name) => { setResolvedMeta(meta); setResolvedName(name); }}
          resolvedMeta={resolvedMeta}
          resolvedName={resolvedName}
          error={error}
          onError={setError}
          selfMeta={stealthAddress ?? null}
        />

        {/* Error */}
        {status === "error" && error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[10px]">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-caption text-red-400">{error}</span>
          </div>
        )}

        {/* Shield / Preview button */}
        {demoMode ? (
          <button
            onClick={submitDemoDeposit}
            disabled={!canSubmitBtc || demoSubmitting}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-3.5 rounded-[12px]",
              "text-body2 font-semibold transition-all cursor-pointer",
              canSubmitBtc && !demoSubmitting
                ? "bg-warning hover:bg-warning/90 text-background shadow-[0_0_20px_rgba(255,170,0,0.15)]"
                : "bg-gray/20 text-gray/50 cursor-not-allowed"
            )}
          >
            {demoSubmitting ? (<><Loader2 className="w-4 h-4 animate-spin" />Shielding (Demo)...</>) : (<><Zap className="w-4 h-4" />Shield BTC (Demo)</>)}
          </button>
        ) : btcWallet.connected ? (
          <button
            onClick={buildTxPreview}
            disabled={!canSubmitBtc || buildingPreview || btcAmountSats < 546 || (btcWallet.balance !== null && btcAmountSats > btcWallet.balance)}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-3.5 rounded-[12px]",
              "text-body2 font-semibold transition-all cursor-pointer",
              canSubmitBtc && !buildingPreview
                ? "btn-privacy shadow-[0_0_20px_rgba(20,241,149,0.15)] hover:shadow-[0_0_30px_rgba(20,241,149,0.25)]"
                : "bg-gray/20 text-gray/50 cursor-not-allowed"
            )}
          >
            {buildingPreview ? (<><Loader2 className="w-4 h-4 animate-spin" />Generating...</>) : (<><Shield className="w-4 h-4" />Shield BTC</>)}
          </button>
        ) : (
          <button
            disabled
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-[12px] text-body2 font-semibold bg-gray/20 text-gray/50 cursor-not-allowed"
          >
            <Shield className="w-4 h-4" />
            Shield BTC
          </button>
        )}
      </div>
    );
  }

  // Passkey user selected SPL token but no wallet connected — prompt to connect
  if (isPasskeyOnly && !selectedToken.isBtcNative) {
    return (
      <div className={cn("space-y-5", className)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-caption text-gray">Asset</span>
          </div>
          {tokenSelector}
        </div>
        <div className="flex flex-col items-center py-8 space-y-4">
          <div className="w-14 h-14 rounded-full bg-sol/10 border border-sol/20 flex items-center justify-center">
            <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-7 h-7 rounded-full" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-body2-semibold text-foreground">Connect Wallet to Shield {selectedToken.symbol}</p>
            <p className="text-caption text-gray max-w-[280px]">
              Shielding {selectedToken.symbol} requires a Solana wallet to sign the deposit transaction. After shielding, all private operations use your passkey.
            </p>
          </div>
          <button
            onClick={() => openWalletModal(true)}
            className={cn(
              "inline-flex items-center gap-2 px-6 py-3 rounded-full",
              "bg-sol hover:bg-sol/80 text-background font-semibold",
              "transition-all cursor-pointer hover:shadow-[0_0_20px_rgba(153,69,255,0.2)]"
            )}
          >
            <Shield className="w-4 h-4" />
            Connect Wallet
          </button>
          <p className="text-[10px] text-gray/40">
            Or select BTC for passkey-only deposits
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-5", className)}>
      {/* Connected wallet bar */}
      {publicKey && (
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
            <Wallet className="w-3 h-3 text-sol" />
            <code className="text-[11px] font-mono text-gray">{publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(publicKey.toBase58());
                setCopiedAddr(true);
                setTimeout(() => setCopiedAddr(false), 1500);
              }}
              className="p-0.5 text-gray/30 hover:text-gray transition-colors cursor-pointer"
              title="Copy address"
            >
              {copiedAddr ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
          <button
            onClick={() => wallet.disconnect()}
            className="flex items-center gap-1 text-[11px] text-gray/50 hover:text-red-400 transition-colors cursor-pointer"
          >
            <LogOut className="w-3 h-3" />
            Disconnect
          </button>
        </div>
      )}

      {/* Amount + Token selector */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-caption text-gray">Amount</span>
          <span className="text-caption text-gray/50">
            {selectedToken.isSOL && solBalance !== null
              ? `Balance: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`
              : splBalance !== null
                ? `Balance: ${(splBalance / (10 ** selectedToken.decimals)).toLocaleString(undefined, { maximumFractionDigits: selectedToken.decimals })} ${selectedToken.symbol}`
                : publicKey
                  ? `Balance: loading...`
                  : ""
            }
          </span>
        </div>
        <div className="flex items-center gap-2 p-3 bg-muted border border-gray/15 rounded-[12px] focus-within:border-privacy/30 transition-colors">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-transparent text-lg font-mono text-foreground placeholder:text-gray/30 outline-none min-w-0"
          />
          <button
            onClick={handleMax}
            className="px-2 py-1 rounded-[6px] bg-privacy/10 border border-privacy/20 text-[10px] font-semibold text-privacy hover:bg-privacy/20 transition-colors cursor-pointer uppercase tracking-wider"
          >
            Max
          </button>
          {tokenSelector}
        </div>
        {selectedToken.isSOL && (
          <p className="text-[10px] text-gray/50 pl-1">
            SOL will be wrapped to wSOL (Token-2022) for shielding. The wrapper account is closed after shielding.
          </p>
        )}
      </div>

      {/* Recipient stealth address */}
      <StealthRecipientInput
        onResolved={(meta, name) => { setResolvedMeta(meta); setResolvedName(name); }}
        resolvedMeta={resolvedMeta}
        resolvedName={resolvedName}
        error={error}
        onError={setError}
        selfMeta={stealthAddress ?? null}
      />

      {/* Error */}
      {status === "error" && error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[10px]">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-caption text-red-400">{error}</span>
        </div>
      )}

      {/* Shield button */}
      <button
        onClick={handleShield}
        disabled={!canSubmit || status === "processing"}
        className={cn(
          "w-full flex items-center justify-center gap-2 py-3.5 rounded-[12px]",
          "text-body2 font-semibold transition-all cursor-pointer",
          canSubmit && status !== "processing"
            ? "btn-privacy shadow-[0_0_20px_rgba(20,241,149,0.15)] hover:shadow-[0_0_30px_rgba(20,241,149,0.25)]"
            : "bg-gray/20 text-gray/50 cursor-not-allowed"
        )}
      >
        {status === "processing" ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Shielding...
          </>
        ) : (
          <>
            <Shield className="w-4 h-4" />
            Shield {selectedToken.symbol}
          </>
        )}
      </button>
    </div>
  );
}
