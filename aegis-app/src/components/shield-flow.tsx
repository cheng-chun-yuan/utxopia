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
  NATIVE_MINT,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { getConfig, createStealthOutputWithKeys, computeTokenId } from "@aegis/sdk";
import { useAegis } from "@/hooks/use-aegis";
import { Shield, ChevronDown, Loader2, ExternalLink, CheckCircle2, AlertCircle, LogOut, Wallet, Copy, Check, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import type { StealthMetaAddress } from "@aegis/sdk";
import { SHIELD_TOKENS } from "@/lib/supported-tokens";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";

import { MobileWalletGuidance } from "@/components/bitcoin-wallet-selector";
import { useIsMobileWithoutWallet } from "@/hooks/use-mobile-wallet-detect";
import { BTC_DUST_LIMIT, TOKEN_2022_PROGRAM_ID_STR } from "@/lib/btc-constants";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { useBtcDeposit } from "@/hooks/use-btc-deposit";

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
  const [copiedAddr, setCopiedAddr] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── BTC-specific state (extracted to hook) ──
  const btcDeposit = useBtcDeposit({
    stealthAddress,
    resolvedMeta,
    onStatusChange: (s) => setStatus(s),
    onError: (msg) => setError(msg || null),
  });
  const { btcWallet } = btcDeposit;
  const { solBalance, splBalance, handleMax } = useTokenBalance(selectedToken, publicKey, connection, btcWallet.balance);
  const isMobileNoWallet = useIsMobileWithoutWallet();

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (btcDeposit.walletPickerRef.current && !btcDeposit.walletPickerRef.current.contains(e.target as Node)) {
        btcDeposit.setShowWalletPicker(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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

      const config = getConfig();
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * (10 ** selectedToken.decimals)));

      // Determine mint: SOL uses native wSOL, others use their configured mint
      const mintPubkey = selectedToken.isSOL
        ? NATIVE_MINT
        : selectedToken.mint
          ? new PublicKey(selectedToken.mint)
          : new PublicKey(config.zkbtcMint);

      const tokenIdBigint = computeTokenId(mintPubkey.toBuffer());
      const stealthOutput = await createStealthOutputWithKeys(keys, amountRaw, tokenIdBigint);
      const { npkBytes } = stealthOutput;

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
        ixData.set(stealthOutput.ephemeralPub, 41);

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
        ixData.set(stealthOutput.ephemeralPub, 41);

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
      setError(err instanceof Error ? err.message : "Shield failed");
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
      btcDeposit.setBtcAmount("");
      setTxSig(null);
      btcDeposit.setWalletDepositResult(null);
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
          {isBtc && btcDeposit.walletDepositResult
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
        {/* BTC tx link */}
        {btcDeposit.walletDepositResult?.txid && (
          <a
            href={`${getMempoolExplorerUrl()}/tx/${btcDeposit.walletDepositResult.txid}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-caption text-btc hover:text-btc/80 transition-colors"
          >
            View on mempool.space <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <div className="pt-2">
          <button
            onClick={resetDone}
            className="px-5 py-2 rounded-[10px] bg-muted border border-gray/15 text-body2 text-gray-light hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
          >
            Shield more
          </button>
        </div>
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
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // BTC native deposit flow — unified layout matching SPL flow
  if (selectedToken.isBtcNative) {
    const btcAmountSats = Math.floor(parseFloat(btcDeposit.btcAmount || "0") * 1e8);
    const canSubmitBtc = btcAmountSats > 0 && !!resolvedMeta && !!keys;

    // PSBT preview active — show transaction details
    if (btcDeposit.depositPreview) {
      const depositPreview = btcDeposit.depositPreview;
      const totalInput = depositPreview.cachedUtxos
        .filter((u) => btcDeposit.selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
        .reduce((sum, u) => sum + u.value, 0);
      const estimatedVsize = btcDeposit.selectedUtxoKeys.size * 68 + 78 + 43 + 43 + 12;
      const estimatedFee = estimatedVsize * 2;
      const changeAmount = totalInput - depositPreview.depositAmountSats - estimatedFee;
      const insufficientFunds = totalInput < depositPreview.depositAmountSats + estimatedFee;

      return (
        <div className={cn("space-y-3", className)}>
          {/* Inputs */}
          <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
            <div className="flex items-center justify-between">
              <p className="text-caption text-gray">
                Inputs ({btcDeposit.selectedUtxoKeys.size} UTXO{btcDeposit.selectedUtxoKeys.size !== 1 ? "s" : ""})
                <span className="text-foreground ml-1">{(totalInput / 1e8).toFixed(8)} BTC</span>
              </p>
              <div className="flex items-center gap-2">
                {btcDeposit.showUtxoList && (
                  <button onClick={() => btcDeposit.setEditingUtxos(!btcDeposit.editingUtxos)} className={cn("text-[10px] transition-colors cursor-pointer", btcDeposit.editingUtxos ? "text-warning hover:text-warning/80" : "text-sol hover:text-sol-light")}>
                    {btcDeposit.editingUtxos ? "Done" : "Edit"}
                  </button>
                )}
                <button onClick={() => { btcDeposit.setShowUtxoList(!btcDeposit.showUtxoList); if (btcDeposit.showUtxoList) btcDeposit.setEditingUtxos(false); }} className="text-[10px] text-gray hover:text-gray-light transition-colors cursor-pointer">
                  {btcDeposit.showUtxoList ? "Hide" : "Show UTXOs"}
                </button>
              </div>
            </div>
            {btcDeposit.showUtxoList && (
              <div className="space-y-1.5 max-h-36 overflow-y-auto mt-2">
                {depositPreview.cachedUtxos.map((utxo) => {
                  const key = `${utxo.txid}:${utxo.vout}`;
                  const isSelected = btcDeposit.selectedUtxoKeys.has(key);
                  if (!btcDeposit.editingUtxos && !isSelected) return null;
                  return (
                    <div key={key} className={cn("flex items-center gap-2 p-2 rounded-[8px] transition-colors", btcDeposit.editingUtxos ? "cursor-pointer" : "", isSelected ? "bg-btc/10 border border-btc/20" : "bg-background border border-gray/10 hover:border-gray/25")}
                      onClick={btcDeposit.editingUtxos ? () => btcDeposit.setSelectedUtxoKeys((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; }) : undefined}>
                      {btcDeposit.editingUtxos && <input type="checkbox" checked={isSelected} readOnly className="accent-btc w-3.5 h-3.5 pointer-events-none" />}
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
            <button onClick={() => btcDeposit.setShowOpReturn(!btcDeposit.showOpReturn)} className="w-full flex items-center justify-between cursor-pointer">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-privacy/15 flex items-center justify-center"><Shield className="w-3 h-3 text-privacy" /></div>
                <span className="text-caption font-semibold text-privacy">ZK Metadata</span>
                <span className="text-[10px] text-privacy/50">64 bytes</span>
              </div>
              <ChevronDown className={cn("w-3.5 h-3.5 text-gray transition-transform duration-200", btcDeposit.showOpReturn && "rotate-180")} />
            </button>
            {btcDeposit.showOpReturn && (
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
            <button onClick={() => btcDeposit.setDepositPreview(null)} disabled={btcDeposit.walletDepositing}
              className="flex-1 py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2 bg-muted hover:bg-gray/20 text-foreground border border-gray/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              Back
            </button>
            <button onClick={btcDeposit.confirmAndSign} disabled={btcDeposit.walletDepositing || insufficientFunds || btcDeposit.selectedUtxoKeys.size === 0}
              className={cn("flex-[2] py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer",
                "bg-btc hover:bg-btc/90 text-background disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed")}>
              {btcDeposit.walletDepositing ? (<><Loader2 className="w-4 h-4 animate-spin" />Signing...</>) : (<><Wallet className="w-4 h-4" />Confirm &amp; Sign</>)}
            </button>
          </div>
        </div>
      );
    }

    // Main BTC form — unified layout
    return (
      <div className={cn("space-y-5", className)}>
        {/* BTC Wallet bar */}
        <div className="flex items-center justify-between gap-2">
          {btcWallet.connected ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <img src="/tokens/btc.png" alt="BTC" className="w-3.5 h-3.5 rounded-full shrink-0" />
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
            {btcDeposit.buildingPreview ? (<><Loader2 className="w-4 h-4 animate-spin" />Generating...</>) : (<><Shield className="w-4 h-4" />Shield BTC</>)}
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
            onClick={onMax}
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
