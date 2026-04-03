"use client";

import { memo, useMemo } from "react";

interface ExpiryDateProps {
  timestamp: number;
}

const ExpiryDate = memo(function ExpiryDate({ timestamp }: ExpiryDateProps) {
  const formattedDate = useMemo(
    () => new Date(timestamp * 1000).toLocaleString(),
    [timestamp]
  );

  return <li>Deposit expires at {formattedDate}</li>;
});

ExpiryDate.displayName = "ExpiryDate";

interface ImportantInfoProps {
  amountSats: number;
  expiresAt: number;
}

export const ImportantInfo = memo(function ImportantInfo({
  amountSats,
  expiresAt,
}: ImportantInfoProps) {
  const formattedAmount = useMemo(
    () => amountSats.toLocaleString(),
    [amountSats]
  );

  return (
    <div className="p-4 bg-muted rounded-lg space-y-2">
      <p className="text-sm font-medium">Important:</p>
      <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
        <li>Send exactly {formattedAmount} sats</li>
        <ExpiryDate timestamp={expiresAt} />
        <li>Your note is saved locally - don&apos;t clear browser data</li>
      </ul>
    </div>
  );
});

ImportantInfo.displayName = "ImportantInfo";
