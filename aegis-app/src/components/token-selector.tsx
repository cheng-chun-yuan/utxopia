"use client";

import { useState, useEffect } from "react";
import {
  getRegisteredTokens,
  getActiveTokenMint,
  setActiveToken,
  type TokenInfo,
} from "@/lib/token-context";

interface TokenSelectorProps {
  onChange?: (token: TokenInfo) => void;
  className?: string;
}

export function TokenSelector({ onChange, className }: TokenSelectorProps) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    const registered = getRegisteredTokens();
    setTokens(registered);
    setSelected(getActiveTokenMint());
  }, []);

  const handleChange = (mint: string) => {
    setSelected(mint);
    setActiveToken(mint);
    const token = tokens.find((t) => t.mint === mint);
    if (token && onChange) onChange(token);
  };

  if (tokens.length <= 1) {
    // Single token — show label, no dropdown
    const token = tokens[0];
    return (
      <div className={`flex items-center gap-2 ${className ?? ""}`}>
        <span className="text-sm font-medium text-zinc-300">
          {token?.symbol ?? "zkBTC"}
        </span>
      </div>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => handleChange(e.target.value)}
      className={`bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${className ?? ""}`}
    >
      {tokens.map((t) => (
        <option key={t.mint} value={t.mint}>
          {t.symbol} — {t.name}
        </option>
      ))}
    </select>
  );
}
