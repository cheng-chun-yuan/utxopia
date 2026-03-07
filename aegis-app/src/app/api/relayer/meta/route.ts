/**
 * GET /api/relayer/meta — Returns relayer and service fee configuration
 *
 * Two separate fees:
 * - relayer_fee_sats: paid to relayer as a shielded note (for private JoinSplit sends)
 * - service_fee_sats: deducted from BTC withdrawal amount (protocol revenue to pool)
 *
 * stealth_meta: full 96-byte hex-encoded stealth meta-address (spendingPub + viewingPub + mpk)
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    stealth_meta: process.env.RELAYER_STEALTH_META || null,
    relayer_fee_sats: parseInt(process.env.RELAYER_FEE_SATS || "2000", 10),
    service_fee_sats: parseInt(process.env.SERVICE_FEE_SATS || "2000", 10),
  });
}
