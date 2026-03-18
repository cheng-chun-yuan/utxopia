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
import { Shield, ChevronDown, Loader2, ExternalLink, CheckCircle2, AlertCircle, LogOut, Wallet, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DepositFlow } from "@/components/btc-widget/deposit-flow";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import type { StealthMetaAddress } from "@aegis/sdk";
import { SHIELD_TOKENS } from "@/lib/supported-tokens";

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

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
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
    if (selectedToken.isSOL && solBalance !== null) {
      // Reserve ~0.01 SOL for tx fees
      const maxLamports = Math.max(0, solBalance - 0.01 * LAMPORTS_PER_SOL);
      setAmount((maxLamports / LAMPORTS_PER_SOL).toFixed(9));
    } else if (!selectedToken.isSOL && !selectedToken.isBtcNative && splBalance !== null) {
      const value = splBalance / (10 ** selectedToken.decimals);
      setAmount(value.toFixed(selectedToken.decimals));
    } else {
      setAmount("0");
    }
  }, [selectedToken, solBalance, splBalance]);

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
    return (
      <div className={cn("space-y-4 text-center py-6", className)}>
        <div className="inline-flex p-3 rounded-full bg-privacy/10 border border-privacy/20">
          <CheckCircle2 className="w-8 h-8 text-privacy" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">Tokens Shielded!</h3>
        <p className="text-caption text-gray">
          Your {selectedToken.symbol} tokens are now private commitments.
        </p>
        {txSig && (
          <a
            href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-caption text-sol hover:text-sol/80 transition-colors"
          >
            View transaction <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <button
          onClick={() => { setStatus("idle"); setAmount(""); setTxSig(null); }}
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

  // BTC native deposit flow
  if (selectedToken.isBtcNative) {
    return (
      <div className={cn("space-y-5", className)}>
        {/* Token selector bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-caption text-gray">Asset</span>
            <span className="px-1.5 py-0.5 rounded bg-btc/10 text-[9px] text-btc font-semibold uppercase">Native Bitcoin</span>
          </div>
          {tokenSelector}
        </div>

        {/* BTC Deposit Flow */}
        <div className="rounded-[12px] border border-btc/15 bg-btc/5 p-4">
          <DepositFlow />
        </div>
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
