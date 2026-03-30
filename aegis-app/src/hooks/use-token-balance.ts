import { useState, useEffect, useCallback } from "react";
import { PublicKey, LAMPORTS_PER_SOL, type Connection } from "@solana/web3.js";
import { getConfig } from "@aegis/sdk";
import { BTC_MINER_FEE_ESTIMATE, TOKEN_2022_PROGRAM_ID_STR } from "@/lib/btc-constants";
import type { SupportedToken } from "@/lib/supported-tokens";

const TOKEN_2022_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ID_STR);

/**
 * Fetches SOL and SPL token balances based on the selected token,
 * and provides a handleMax() that returns the max amount string.
 */
export function useTokenBalance(
  selectedToken: SupportedToken,
  publicKey: PublicKey | null,
  connection: Connection,
  btcBalance: number | null,
) {
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [splBalance, setSplBalance] = useState<number | null>(null);

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

  const handleMax = useCallback((): string => {
    if (selectedToken.isBtcNative && btcBalance !== null) {
      const maxSats = Math.max(0, btcBalance - BTC_MINER_FEE_ESTIMATE);
      return (maxSats / 1e8).toFixed(8);
    } else if (selectedToken.isSOL && solBalance !== null) {
      const maxLamports = Math.max(0, solBalance - 0.01 * LAMPORTS_PER_SOL);
      return (maxLamports / LAMPORTS_PER_SOL).toFixed(9);
    } else if (!selectedToken.isSOL && !selectedToken.isBtcNative && splBalance !== null) {
      const value = splBalance / (10 ** selectedToken.decimals);
      return value.toFixed(selectedToken.decimals);
    }
    return "0";
  }, [selectedToken, solBalance, splBalance, btcBalance]);

  return { solBalance, splBalance, handleMax };
}
