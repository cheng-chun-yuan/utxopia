"use client";

import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { getConfig, computeTokenId, computeNPKSync, computeMPKSync } from "@aegis/sdk";
import { useAegis } from "@/hooks/use-aegis";
import { getActiveTokenId, getActiveTokenMint, getRegisteredTokens, type TokenInfo } from "@/lib/token-context";
import { TokenSelector } from "./token-selector";
import { ed25519GenerateKeyPair, x25519Ecdh, ed25519PubToX25519 } from "@aegis/sdk";

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

interface ShieldFlowProps {
  className?: string;
}

type ShieldStep = "select" | "amount" | "confirm" | "processing" | "done" | "error";

export function ShieldFlow({ className }: ShieldFlowProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { keys, stealthAddress } = useAegis();

  const [step, setStep] = useState<ShieldStep>("select");
  const [selectedToken, setSelectedToken] = useState<TokenInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  const handleTokenSelect = useCallback((token: TokenInfo) => {
    setSelectedToken(token);
    setStep("amount");
  }, []);

  const handleShield = useCallback(async () => {
    if (!publicKey || !keys || !selectedToken || !amount) return;

    try {
      setStep("processing");
      setError(null);

      const config = getConfig();
      const amountRaw = BigInt(Math.floor(parseFloat(amount) * (10 ** selectedToken.decimals)));

      // Generate ephemeral keypair for stealth announcement
      const ephemeral = ed25519GenerateKeyPair();

      // Compute NPK from keys
      const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);
      const viewingPubX25519 = ed25519PubToX25519(keys.viewingPubKey);
      const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubX25519);

      // Derive stealth scalar for NPK
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
      // Reduce to BN254 field
      const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      stealthScalar = stealthScalar % BN254_FIELD;

      const npk = computeNPKSync(mpk, stealthScalar);

      // Convert NPK to 32 bytes (big-endian)
      const npkBytes = new Uint8Array(32);
      let n = npk;
      for (let i = 31; i >= 0; i--) {
        npkBytes[i] = Number(n & 0xffn);
        n >>= 8n;
      }

      // Derive TokenConfig PDA
      const mintPubkey = new PublicKey(selectedToken.mint);
      const [tokenConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_config"), mintPubkey.toBuffer()],
        new PublicKey(config.aegisProgramId),
      );

      // Find user's token account for this mint
      const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
        mint: mintPubkey,
        programId: TOKEN_2022_PROGRAM_ID,
      });

      if (tokenAccounts.value.length === 0) {
        throw new Error(`No ${selectedToken.symbol} token account found. Create one first.`);
      }
      const userTokenAccount = tokenAccounts.value[0].pubkey;

      // Find vault from TokenConfig (or derive)
      // For now, use the pool vault from config for zkBTC, or derive for other tokens
      const vaultPubkey = new PublicKey(config.poolVault); // TODO: read from TokenConfig

      // Build shield instruction
      // disc(1) + amount(8) + npk(32) + ephemeral_pub(32) = 73 bytes
      const ixData = new Uint8Array(73);
      ixData[0] = 29; // SHIELD discriminator

      const dataView = new DataView(ixData.buffer);
      dataView.setBigUint64(1, amountRaw, true); // amount LE
      ixData.set(npkBytes, 9);
      ixData.set(ephemeral.pubKey, 41);

      const [poolStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_state")],
        new PublicKey(config.aegisProgramId),
      );
      const [commitmentTreePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("commitment_tree")],
        new PublicKey(config.aegisProgramId),
      );

      const shieldIx = new TransactionInstruction({
        programId: new PublicKey(config.aegisProgramId),
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
      });

      const tx = new Transaction().add(shieldIx);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      setTxSig(sig);
      setStep("done");
    } catch (err: any) {
      setError(err.message || "Shield failed");
      setStep("error");
    }
  }, [publicKey, keys, selectedToken, amount, connection, sendTransaction]);

  const tokens = getRegisteredTokens();

  return (
    <div className={`space-y-4 ${className ?? ""}`}>
      {step === "select" && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-zinc-100">Select Token to Shield</h3>
          <p className="text-sm text-zinc-400">
            Choose an SPL token to deposit into the privacy pool.
          </p>
          <div className="grid gap-3">
            {tokens.map((token) => (
              <button
                key={token.mint}
                onClick={() => handleTokenSelect(token)}
                className="flex items-center justify-between p-4 bg-zinc-800/50 border border-zinc-700 rounded-xl hover:border-blue-500/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold">
                    {token.symbol.slice(0, 2)}
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-zinc-200">{token.symbol}</div>
                    <div className="text-xs text-zinc-500">{token.name}</div>
                  </div>
                </div>
                <div className="text-xs text-zinc-500">{token.decimals} decimals</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "amount" && selectedToken && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold">
              {selectedToken.symbol.slice(0, 2)}
            </div>
            <h3 className="text-lg font-semibold text-zinc-100">
              Shield {selectedToken.symbol}
            </h3>
          </div>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={`Amount in ${selectedToken.symbol}`}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex gap-3">
            <button
              onClick={() => setStep("select")}
              className="flex-1 px-4 py-2 bg-zinc-700 text-zinc-300 rounded-lg hover:bg-zinc-600 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleShield}
              disabled={!amount || parseFloat(amount) <= 0}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Shield {selectedToken.symbol}
            </button>
          </div>
        </div>
      )}

      {step === "processing" && (
        <div className="text-center py-8">
          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-zinc-300">Shielding tokens...</p>
        </div>
      )}

      {step === "done" && (
        <div className="text-center py-8 space-y-4">
          <div className="text-4xl">🛡️</div>
          <h3 className="text-lg font-semibold text-green-400">Tokens Shielded!</h3>
          <p className="text-sm text-zinc-400">
            Your {selectedToken?.symbol} tokens are now private commitments in the Merkle tree.
          </p>
          {txSig && (
            <a
              href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-400 hover:underline"
            >
              View transaction
            </a>
          )}
          <button
            onClick={() => { setStep("select"); setAmount(""); setTxSig(null); }}
            className="px-4 py-2 bg-zinc-700 text-zinc-300 rounded-lg hover:bg-zinc-600 transition-colors"
          >
            Shield more
          </button>
        </div>
      )}

      {step === "error" && (
        <div className="text-center py-8 space-y-4">
          <div className="text-4xl">❌</div>
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => setStep("amount")}
            className="px-4 py-2 bg-zinc-700 text-zinc-300 rounded-lg hover:bg-zinc-600 transition-colors"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
