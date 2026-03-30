/**
 * TransferDetails — dispatcher component that renders the appropriate
 * detail view based on the transfer kind.
 */

import type { RedemptionRecord } from "@/hooks/use-explorer";
import { getTransferKind } from "../transfers-tab";
import { ShieldDetails } from "./shield-details";
import { RedeemDetails } from "./redeem-details";
import { UnshieldDetails } from "./unshield-details";
import { StandardTransferDetails } from "./standard-transfer-details";
import type { TransferTx } from "./detail-helpers";

export function TransferDetails({ tx, redemption }: { tx: TransferTx; redemption?: RedemptionRecord }) {
  const kind = getTransferKind(tx);
  if (kind === "shield") return <ShieldDetails tx={tx} />;
  if (kind === "withdraw") return <RedeemDetails tx={tx} redemption={redemption} />;
  if (kind === "unshield") return <UnshieldDetails tx={tx} />;
  return <StandardTransferDetails tx={tx} />;
}
