import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getConfig } from "@aegis/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const getBtcLightClientProgramId = () => new PublicKey(getConfig().btcLightClientProgramId);

function deriveLightClientPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client")],
    getBtcLightClientProgramId()
  );
}

export async function POST() {
  try {
    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const [lightClientPDA] = deriveLightClientPDA();
    const existingAccount = await connection.getAccountInfo(lightClientPDA);

    if (existingAccount) {
      return NextResponse.json({
        success: true,
        already_exists: true,
        light_client_pda: lightClientPDA.toBase58(),
        message: "Light client already initialized",
      });
    }

    return NextResponse.json(
      {
        success: false,
        error: "Light client not initialized. Use the header relayer service: cd backend/header-relayer && bun run init",
        light_client_pda: lightClientPDA.toBase58(),
      },
      { status: 501 }
    );
  } catch (error) {
    console.error("[Init API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
