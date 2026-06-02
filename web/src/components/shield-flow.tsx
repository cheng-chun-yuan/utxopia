"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
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
  NATIVE_MINT,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { UTXOpiaClient } from "@utxopia/sdk";
import { getUTXOpiaProgramId, getZkbtcMint, derivePoolStatePDA, deriveCommitmentTreePDA, deriveTokenConfigPDA } from "@/lib/solana/pdas";
import { useUTXOpia } from "@/hooks/use-utxopia";
import { Shield, ChevronDown, Loader2, AlertCircle, LogOut, Wallet, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import type { StealthMetaAddress } from "@utxopia/sdk";
import { SHIELD_TOKENS } from "@/lib/supported-tokens";

import { MobileWalletGuidance } from "@/components/bitcoin-wallet-selector";
import { useIsMobileWithoutWallet } from "@/hooks/use-mobile-wallet-detect";
import { BTC_DUST_LIMIT, TOKEN_2022_PROGRAM_ID_STR } from "@/lib/btc-constants";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { useBtcDeposit } from "@/hooks/use-btc-deposit";
import { BtcDepositPreview } from "@/components/shield-flow/btc-deposit-preview";
import { ShieldSuccess } from "@/components/shield-flow/shield-success";
import { TokenSelector } from "@/components/shield-flow/token-selector";

const TOKEN_2022_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ID_STR);

interface ShieldFlowProps {
  className?: string;
}

type ShieldStatus = "idle" | "processing" | "done" | "error";

export function ShieldFlow({ className }: ShieldFlowProps) {
  const wallet = useWallet();
  const { publicKey, sendTransaction } = wallet;
  const { connection } = useConnection();
  const { setVisible: openWalletModal } = useWalletModal();
  const { keys, stealthAddress } = useUTXOpia();

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
  const [copiedAddr, setCopiedAddr] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── BTC-specific state (extracted to hook) ──
  const btcDeposit = useBtcDeposit({
    resolvedMeta,
    onStatusChange: (s) => setStatus(s),
    onError: (msg) => setError(msg || null),
  });
  const { btcWallet } = btcDeposit;
  const { walletPickerRef, setShowWalletPicker } = btcDeposit;
  const { solBalance, splBalance, handleMax } = useTokenBalance(selectedToken, publicKey, connection, btcWallet.balance);
  const isMobileNoWallet = useIsMobileWithoutWallet();

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
  }, [setShowWalletPicker, walletPickerRef]);

  // No auto-resolve — user clicks the Self button or types a recipient.
  // This avoids resolvedMeta getting out of sync with the input value.

  const onMax = useCallback(() => {
    const max = handleMax();
    if (selectedToken.isBtcNative) btcDeposit.setBtcAmount(max);
    else setAmount(max);
  }, [handleMax, selectedToken.isBtcNative, btcDeposit]);

  const handleShield = useCallback(async () => {
    if (!publicKey || !keys || !amount || !resolvedMeta) return;

    try {
      setStatus("processing");
      setError(null);

      const amountRaw = BigInt(Math.floor(parseFloat(amount) * (10 ** selectedToken.decimals)));

      // Determine mint: SOL uses native wSOL, others use their configured mint
      const mintPubkey = selectedToken.isSOL
        ? NATIVE_MINT
        : selectedToken.mint
          ? new PublicKey(selectedToken.mint)
          : getZkbtcMint();

      const client = UTXOpiaClient.instance();
      const mintAddr = mintPubkey.toBase58();
      const shieldOutput = await client.prepareShieldOutput({ amount: amountRaw, mintAddress: mintAddr });
      const { npkBytes } = shieldOutput;

      const programId = getUTXOpiaProgramId();
      const [tokenConfigPda] = deriveTokenConfigPDA(mintPubkey);
      const [poolStatePda] = derivePoolStatePDA();
      const [commitmentTreePda] = deriveCommitmentTreePDA();

      const tx = new Transaction();
      let userTokenAccount: PublicKey;

      if (selectedToken.isSOL) {
        // SOL shielding: wrap SOL → wSOL (native, legacy Token program) → shield → close wSOL account
        const wsolAta = getAssociatedTokenAddressSync(
          NATIVE_MINT,
          publicKey,
          false,
          SPL_TOKEN_PROGRAM_ID,
        );

        // 1. Create wSOL ATA if needed (idempotent)
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            wsolAta,
            publicKey,
            NATIVE_MINT,
            SPL_TOKEN_PROGRAM_ID,
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
          createSyncNativeInstruction(wsolAta, SPL_TOKEN_PROGRAM_ID),
        );

        userTokenAccount = wsolAta;

        // Read vault from TokenConfig PDA on-chain
        const tokenConfigAccount = await connection.getAccountInfo(tokenConfigPda);
        if (!tokenConfigAccount) {
          throw new Error("SOL token not registered on-chain. Admin must register wSOL first.");
        }
        // vault is at offset 66..98 in TokenConfig (disc:1 + bump:1 + mint:32 + tokenId:32 = 66)
        const vaultBytes = tokenConfigAccount.data.slice(66, 98);
        const vaultPubkey = new PublicKey(vaultBytes);

        // 4. Shield instruction (use legacy Token program for wSOL)
        const ixData = new Uint8Array(73);
        ixData[0] = 12; // SHIELD discriminator
        const dataView = new DataView(ixData.buffer);
        dataView.setBigUint64(1, amountRaw, true);
        ixData.set(npkBytes, 9);
        ixData.set(shieldOutput.ephemeralPub, 41);

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
            { pubkey: new PublicKey(SPL_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
          ],
        }));

        // 5. Close wSOL account to reclaim rent (returns leftover SOL to user)
        tx.add(
          createCloseAccountInstruction(wsolAta, publicKey, publicKey, [], SPL_TOKEN_PROGRAM_ID),
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
        ixData[0] = 12; // SHIELD discriminator
        const dataView = new DataView(ixData.buffer);
        dataView.setBigUint64(1, amountRaw, true);
        ixData.set(npkBytes, 9);
        ixData.set(shieldOutput.ephemeralPub, 41);

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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Add funds failed");
      setStatus("error");
    }
  }, [publicKey, keys, selectedToken, amount, resolvedMeta, connection, sendTransaction]);

  const canSubmit = !!amount && parseFloat(amount) > 0 && !!resolvedMeta && !!publicKey && !!keys;

  // Success state
  if (status === "done") {
    const resetDone = () => {
      setStatus("idle");
      setAmount("");
      btcDeposit.setBtcAmount("");
      setTxSig(null);
      btcDeposit.setWalletDepositResult(null);
    };

    return (
      <ShieldSuccess
        className={className}
        selectedToken={selectedToken}
        txSig={txSig}
        walletDepositResult={btcDeposit.walletDepositResult}
        onReset={resetDone}
      />
    );
  }

  // Token selector dropdown — shared across both flows
  const tokenSelector = (
    <TokenSelector
      selectedToken={selectedToken}
      availableTokens={availableTokens}
      dropdownOpen={dropdownOpen}
      dropdownRef={dropdownRef}
      onOpenChange={setDropdownOpen}
      onSelect={setSelectedToken}
    />
  );

  // BTC native deposit flow — unified layout matching SPL flow
  if (selectedToken.isBtcNative) {
    const btcAmountSats = Math.floor(parseFloat(btcDeposit.btcAmount || "0") * 1e8);
    const canSubmitBtc = btcAmountSats > 0 && !!resolvedMeta && !!keys;

    // PSBT preview active — show transaction details
    if (btcDeposit.depositPreview) {
      return (
        <BtcDepositPreview
          className={className}
          btcDeposit={btcDeposit}
          status={status}
          error={error}
        />
      );
    }

    // Main BTC form — unified layout
    return (
      <div className={cn("space-y-5", className)}>
        {/* BTC Wallet bar */}
        <div className="flex items-center justify-between gap-2">
          {btcWallet.connected ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <Image src="/tokens/btc.png" alt="BTC" width={14} height={14} className="rounded-full shrink-0" />
              <code className="text-[11px] font-mono text-gray truncate">
                {btcWallet.address?.slice(0, 6)}...{btcWallet.address?.slice(-4)}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(btcWallet.address!); btcDeposit.setCopiedBtcAddr(true); setTimeout(() => btcDeposit.setCopiedBtcAddr(false), 1500); }}
                className="p-0.5 text-gray/30 hover:text-gray transition-colors cursor-pointer shrink-0" title="Copy address"
              >
                {btcDeposit.copiedBtcAddr ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              </button>
              <button onClick={() => btcWallet.disconnect()} className="p-0.5 text-gray/30 hover:text-red-400 transition-colors cursor-pointer shrink-0" title="Disconnect">
                <LogOut className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div className="relative flex-1 min-w-0" ref={btcDeposit.walletPickerRef}>
              {isMobileNoWallet ? (
                <MobileWalletGuidance />
              ) : (
                <>
                  <button
                    onClick={() => btcDeposit.setShowWalletPicker(!btcDeposit.showWalletPicker)}
                    disabled={btcWallet.connecting}
                    className="w-full py-2.5 rounded-[10px] font-semibold transition-all flex items-center justify-center gap-2 bg-btc/10 hover:bg-btc/20 text-btc border border-btc/25 disabled:opacity-50 cursor-pointer text-[13px]"
                  >
                    {btcWallet.connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wallet className="w-3.5 h-3.5" />}
                    Connect BTC Wallet
                    <ChevronDown className={cn("w-3 h-3 transition-transform", btcDeposit.showWalletPicker && "rotate-180")} />
                  </button>
                  {btcDeposit.showWalletPicker && (
                    <div className="absolute left-0 right-0 top-full mt-1.5 bg-card border border-gray/20 rounded-[12px] shadow-xl z-50 overflow-hidden">
                      <button
                        onClick={() => { btcWallet.connect("sats-connect"); btcDeposit.setShowWalletPicker(false); }}
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
                        onClick={() => { btcWallet.connect("unisat"); btcDeposit.setShowWalletPicker(false); }}
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
              value={btcDeposit.btcAmount}
              onChange={(e) => btcDeposit.setBtcAmount(e.target.value)}
              placeholder="0.00000000"
              step="0.00000001"
              className="flex-1 bg-transparent text-lg font-mono text-foreground placeholder:text-gray/30 outline-none min-w-0"
            />
            <button onClick={onMax}
              className="px-2 py-1 rounded-[6px] bg-btc/10 border border-btc/20 text-[10px] font-semibold text-btc hover:bg-btc/20 transition-colors cursor-pointer uppercase tracking-wider">
              Max
            </button>
            {tokenSelector}
          </div>
          {btcDeposit.btcAmount && (
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
          label="Private destination"
          selfMeta={stealthAddress ?? null}
          defaultToSelf
        />

        {/* Error */}
        {status === "error" && error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[10px]">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-caption text-red-400">{error}</span>
          </div>
        )}

        {/* Add funds / Preview button */}
        {btcWallet.connected ? (
          <button
            onClick={btcDeposit.buildTxPreview}
            disabled={!canSubmitBtc || btcDeposit.buildingPreview || btcAmountSats < BTC_DUST_LIMIT || (btcWallet.balance !== null && btcAmountSats > btcWallet.balance)}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-3.5 rounded-[12px]",
              "text-body2 font-semibold transition-all cursor-pointer",
              canSubmitBtc && !btcDeposit.buildingPreview
                ? "btn-privacy shadow-[0_0_20px_rgba(20,241,149,0.15)] hover:shadow-[0_0_30px_rgba(20,241,149,0.25)]"
                : "bg-gray/20 text-gray/50 cursor-not-allowed"
            )}
          >
            {btcDeposit.buildingPreview ? (<><Loader2 className="w-4 h-4 animate-spin" />Generating...</>) : (<><Shield className="w-4 h-4" />Add BTC privately</>)}
          </button>
        ) : (
          <button
            disabled
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-[12px] text-body2 font-semibold bg-gray/20 text-gray/50 cursor-not-allowed"
          >
            <Shield className="w-4 h-4" />
            Add BTC privately
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
            <Image src={selectedToken.logo} alt={selectedToken.symbol} width={28} height={28} className="rounded-full" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-body2-semibold text-foreground">Connect wallet to add {selectedToken.symbol}</p>
            <p className="text-caption text-gray max-w-[280px]">
              Adding {selectedToken.symbol} requires a Solana wallet to sign the deposit transaction. After that, private sends can use your passkey.
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
            Connect wallet
          </button>
          <p className="text-[10px] text-gray/40">
            Or select BTC for passkey-only funding
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
            onClick={onMax}
            className="px-2 py-1 rounded-[6px] bg-privacy/10 border border-privacy/20 text-[10px] font-semibold text-privacy hover:bg-privacy/20 transition-colors cursor-pointer uppercase tracking-wider"
          >
            Max
          </button>
          {tokenSelector}
        </div>
        {selectedToken.isSOL && (
          <p className="text-[10px] text-gray/50 pl-1">
            SOL is wrapped to wSOL for the deposit, then the wrapper account is closed.
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
        label="Private destination"
        selfMeta={stealthAddress ?? null}
        defaultToSelf
      />

      {/* Error */}
      {status === "error" && error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[10px]">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-caption text-red-400">{error}</span>
        </div>
      )}

      {/* Add funds button */}
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
            Adding...
          </>
        ) : (
          <>
            <Shield className="w-4 h-4" />
            Add {selectedToken.symbol} privately
          </>
        )}
      </button>
    </div>
  );
}
