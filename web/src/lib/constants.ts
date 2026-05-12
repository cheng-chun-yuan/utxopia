// Centralized application constants

// Import network config (single source of truth — no env vars needed for addresses)
import { getNetworkConfig } from "./network-config";
import { initConfig, getConfig } from "@utxopia/sdk";

const networkCfg = getNetworkConfig();

// Initialize SDK once at module load — passes addresses from config/networks.json.
// Env vars (NEXT_PUBLIC_SOLANA_RPC_URL) can still override RPC URL.
let _initPromise: Promise<void> | null = null;
export function ensureSdkInit(): Promise<void> {
  if (!_initPromise) {
    _initPromise = initConfig({
      privacyCoinProgramId: networkCfg.solana.privacyCoinProgramId,
      zkbtcMint: networkCfg.tokens.zkbtcMint,
      solanaRpcUrl: networkCfg.solana.rpcUrl,
      groupPubKey: networkCfg.bitcoin.groupPubkey,
    }).then(() => {});
  }
  return _initPromise;
}
// Kick off immediately on first import
ensureSdkInit();

// Timing constants
export const POLLING_INTERVAL_MS = 30_000;
export const COPY_TIMEOUT_MS = 2_000;
export const STATS_REFRESH_MS = 60_000;

// Bitcoin constants
export const SATS_PER_BTC = 100_000_000;

// Validation limits
export const MIN_DEPOSIT_SATS = 1_000;
export const MAX_DEPOSIT_SATS = 10_000_000_000; // 100 BTC
export const MIN_WITHDRAWAL_SATS = 1_000;

// Bitcoin address regex (bech32 and legacy)
export const BTC_ADDRESS_REGEX = /^(bc1|[13]|tb1)[a-zA-HJ-NP-Z0-9]{25,62}$/;

// Dynamic getters — call after ensureSdkInit() resolves
export const getUTXOpiaProgramId = () => getConfig().privacyCoinProgramId;
export const getBtcLightClientId = () => getConfig().btcLightClientProgramId;
export const getPoolStateAddress = () => getConfig().poolStatePda;
export const getCommitmentTreeAddress = () => getConfig().commitmentTreePda;
export const getZkbtcMintAddress = () => getConfig().zkbtcMint;
export const getPoolVaultAddress = () => getConfig().poolVault;
export const getChadbufferProgramId = () => getConfig().chadbufferProgramId;
