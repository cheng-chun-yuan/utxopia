import { NextResponse } from "next/server";
import { fetchAccountInfo, isHeliusConfigured } from "@/lib/helius-server";
const getAegisSDK = () => import("@aegis/sdk");
import bs58 from "bs58";
export const dynamic = "force-dynamic";

/** Read a little-endian u64 from a Uint8Array slice as bigint */
function readU64LE(data: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(data[offset + i]);
  }
  return result;
}

export const runtime = "nodejs";

// Discriminator for PoolState account (not exported by SDK yet)
const POOL_STATE_DISCRIMINATOR = 0x01;

interface PoolStateData {
  discriminator: number;
  bump: number;
  isPaused: boolean;
  authority: string;
  zkbtcMint: string;
  poolVault: string;
  frostVault: string;
  depositCount: string;
  totalMinted: string;
  totalBurned: string;
  pendingRedemptions: string;
  lastUpdate: number;
  minDeposit: string;
  maxDeposit: string;
  totalShielded: string;
  serviceFeeBase: string;
  serviceFeeBps: number;
  feePool: string;
  pendingMinDeposit: string;
  pendingMaxDeposit: string;
  pendingServiceFee: string;
  pendingExecuteAfter: number;
  depositFeeBps: number;
  withdrawalFeeBps: number;
  activeTreeIndex: number;
}

/**
 * GET /api/solana/pool-state
 *
 * Fetch Aegis pool state from Solana using @solana/kit.
 */
export async function GET() {
  const { getConfig } = await getAegisSDK();
  try {
    const accountInfo = await fetchAccountInfo(getConfig().poolStatePda, "devnet");

    if (!accountInfo) {
      return NextResponse.json(
        { success: false, error: "Pool state account not found" },
        { status: 404 }
      );
    }

    const data = accountInfo.data;

    // Validate discriminator
    if (data[0] !== POOL_STATE_DISCRIMINATOR) {
      return NextResponse.json(
        { success: false, error: "Invalid pool state discriminator" },
        { status: 400 }
      );
    }

    // Parse state — matches PoolState repr(C) layout from pool.rs
    // Offsets: disc(1) bump(1) flags(1) pad(1) authority(32) mint(32) poolVault(32) frostVault(32)
    //          depositCount(8)@132 totalMinted(8)@140 totalBurned(8)@148 pendingRedemptions(8)@156
    //          lastUpdate(8)@164 minDeposit(8)@172 maxDeposit(8)@180 totalShielded(8)@188
    //          serviceFeeBase(8)@196 feePool(8)@204
    //          pendingMinDeposit(8)@212 pendingMaxDeposit(8)@220
    //          pendingServiceFee(8)@228 pendingExecuteAfter(8)@236
    //          serviceFeeBps(2)@244 reserved(22)@246
    const state: PoolStateData = {
      discriminator: data[0],
      bump: data[1],
      isPaused: (data[2] & 0x01) !== 0,
      authority: bs58.encode(data.slice(4, 36)),
      zkbtcMint: bs58.encode(data.slice(36, 68)),
      poolVault: bs58.encode(data.slice(68, 100)),
      frostVault: bs58.encode(data.slice(100, 132)),
      depositCount: readU64LE(data, 132).toString(),
      totalMinted: readU64LE(data, 140).toString(),
      totalBurned: readU64LE(data, 148).toString(),
      pendingRedemptions: readU64LE(data, 156).toString(),
      lastUpdate: Number(readU64LE(data, 164)),
      minDeposit: readU64LE(data, 172).toString(),
      maxDeposit: readU64LE(data, 180).toString(),
      totalShielded: readU64LE(data, 188).toString(),
      serviceFeeBase: readU64LE(data, 196).toString(),
      feePool: readU64LE(data, 204).toString(),
      pendingMinDeposit: readU64LE(data, 212).toString(),
      pendingMaxDeposit: readU64LE(data, 220).toString(),
      pendingServiceFee: readU64LE(data, 228).toString(),
      pendingExecuteAfter: Number(readU64LE(data, 236)),
      serviceFeeBps: data[244] | (data[245] << 8),
      depositFeeBps: data[244] | (data[245] << 8),
      withdrawalFeeBps: data[246] | (data[247] << 8),
      activeTreeIndex: data[258] | (data[259] << 8) | (data[260] << 16) | (data[261] << 24),
    };

    return NextResponse.json({
      success: true,
      helius: isHeliusConfigured(),
      address: getConfig().poolStatePda,
      state,
    });
  } catch (error) {
    console.error("[PoolState API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch pool state",
      },
      { status: 500 }
    );
  }
}
