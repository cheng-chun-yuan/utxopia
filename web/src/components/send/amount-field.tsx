"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface AmountFieldProps {
  /** Display value as a decimal string (e.g. "0.001"). */
  value: string;
  onChange: (next: string) => void;
  /** Number of decimals in the underlying base unit (sats=8, USDC=6, etc). */
  decimals: number;
  /** Display unit shown next to the amount ("BTC", "USDC", etc.). */
  unit: string;
  /** Total available in base units (sats / minor units). */
  availableBaseUnits: bigint;
  /** Subtracted from availableBaseUnits when "Max" is pressed. */
  feeBufferBaseUnits?: bigint;
  /** USD value of one whole unit (used for the "≈ $X" preview). */
  usdPerUnit: number | null;
  className?: string;
}

const VALID_DECIMAL = /^[0-9]*\.?[0-9]*$/;

function baseUnitsToDecimal(base: bigint, decimals: number): string {
  if (decimals === 0) return base.toString();
  const s = base.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, -decimals);
  const fracPart = s.slice(-decimals).replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

function decimalToFloat(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function AmountField({
  value,
  onChange,
  decimals,
  unit,
  availableBaseUnits,
  feeBufferBaseUnits = 0n,
  usdPerUnit,
  className,
}: AmountFieldProps) {
  const usdPreview = useMemo(() => {
    if (usdPerUnit == null) return null;
    const v = decimalToFloat(value);
    if (v <= 0) return null;
    const usd = v * usdPerUnit;
    return usd > 0 ? `≈ $${usd.toFixed(2)}` : null;
  }, [value, usdPerUnit]);

  const onMaxClick = () => {
    const usable =
      availableBaseUnits > feeBufferBaseUnits
        ? availableBaseUnits - feeBufferBaseUnits
        : 0n;
    onChange(baseUnitsToDecimal(usable, decimals));
  };

  const handleChange = (raw: string) => {
    if (!VALID_DECIMAL.test(raw)) return; // reject — caller stays at last valid
    onChange(raw);
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="block text-xs text-muted-foreground">Amount</label>
      <div className="relative">
        <input
          aria-label="Amount"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="0"
          className={cn(
            "w-full px-3 py-3 pr-32 rounded-lg",
            "bg-muted/40 border border-gray/15 text-sm font-mono",
            "focus:outline-none focus:ring-2 focus:ring-privacy/40",
          )}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{unit}</span>
          <button
            type="button"
            onClick={onMaxClick}
            className="text-xs px-2 py-1 rounded bg-privacy/10 text-privacy hover:bg-privacy/15"
          >
            Max
          </button>
        </div>
      </div>
      {usdPreview && (
        <div className="text-xs text-muted-foreground">{usdPreview}</div>
      )}
    </div>
  );
}
