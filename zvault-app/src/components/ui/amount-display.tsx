"use client";

import { memo, useMemo } from "react";
import { parseSats } from "@/lib/utils/validation";
import { formatBtc } from "@/lib/utils/formatting";

interface AmountDisplayProps {
  amount: string;
}

export const AmountDisplay = memo(function AmountDisplay({
  amount,
}: AmountDisplayProps) {
  const btcAmount = useMemo(() => {
    const sats = parseSats(amount);
    return sats ? formatBtc(sats) : null;
  }, [amount]);

  return (
    <p className="text-xs text-muted-foreground mt-1">
      {btcAmount ? `≈ ${btcAmount} BTC` : "1 BTC = 100,000,000 satoshis"}
    </p>
  );
});

AmountDisplay.displayName = "AmountDisplay";
