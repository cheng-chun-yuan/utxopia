"use client";

import { useEffect, useState, memo } from "react";

const WORDS = [
  // Privacy words
  { text: "SECRET", color: "green" },
  { text: "PRIVACY", color: "green" },
  { text: "FREEDOM", color: "green" },
  { text: "SHIELD", color: "green" },
  { text: "HIDDEN", color: "green" },
  { text: "STEALTH", color: "green" },
  { text: "ANONYMOUS", color: "green" },
  { text: "ZERO-KNOWLEDGE", color: "purple" },
  { text: "ENCRYPTED", color: "green" },
  { text: "SECURE", color: "green" },
  { text: "PRIVATE", color: "green" },
  { text: "SHIELDED", color: "green" },
  { text: "CONFIDENTIAL", color: "green" },
  { text: "ZK-PROOF", color: "purple" },
  { text: "TRUSTLESS", color: "green" },
  // Bitcoin words
  { text: "BITCOIN", color: "btc" },
  { text: "BTC", color: "btc" },
  { text: "SATOSHI", color: "btc" },
  { text: "HODL", color: "btc" },
  { text: "DECENTRALIZED", color: "btc" },
  { text: "SOVEREIGN", color: "btc" },
  { text: "PERMISSIONLESS", color: "green" },
  { text: "CENSORSHIP-RESISTANT", color: "green" },
  { text: "P2P", color: "btc" },
  { text: "SATS", color: "btc" },
  { text: "UTXO", color: "btc" },
  { text: "HASH", color: "green" },
  { text: "BLOCK", color: "btc" },
  { text: "CHAIN", color: "btc" },
  // Symbols
  { text: "₿", color: "btc" },
  { text: "🔒", color: "green" },
  { text: "⚡", color: "btc" },
];

interface RainColumn {
  id: number;
  left: number;
  duration: number;
  delay: number;
  words: Array<{ text: string; color: string }>;
  opacity: number;
  fontSize: number;
}

function generateColumn(id: number): RainColumn {
  const wordCount = Math.floor(Math.random() * 8) + 5;
  const words = Array.from({ length: wordCount }, () =>
    WORDS[Math.floor(Math.random() * WORDS.length)]
  );

  return {
    id,
    left: Math.random() * 100,
    duration: Math.random() * 15 + 10, // 10-25 seconds
    delay: Math.random() * 20,
    words,
    opacity: Math.random() * 0.4 + 0.2, // 0.2-0.6
    fontSize: Math.random() * 4 + 10, // 10-14px
  };
}

const RainColumnComponent = memo(function RainColumnComponent({
  column
}: {
  column: RainColumn
}) {
  return (
    <div
      className="rain-column"
      style={{
        left: `${column.left}%`,
        animationDuration: `${column.duration}s`,
        animationDelay: `${column.delay}s`,
        opacity: column.opacity,
        fontSize: `${column.fontSize}px`,
      }}
    >
      {column.words.map((word, idx) => (
        <span
          key={idx}
          className={word.color === "btc" ? "btc" : word.color === "purple" ? "purple" : ""}
        >
          {word.text}
        </span>
      ))}
    </div>
  );
});

RainColumnComponent.displayName = "RainColumnComponent";

export const MatrixRain = memo(function MatrixRain() {
  const [columns, setColumns] = useState<RainColumn[]>([]);

  useEffect(() => {
    // Generate initial columns
    const initialColumns = Array.from({ length: 25 }, (_, i) => generateColumn(i));
    setColumns(initialColumns);

    // Regenerate columns periodically for variation
    const interval = setInterval(() => {
      setColumns(prev => {
        const newColumns = [...prev];
        const indexToUpdate = Math.floor(Math.random() * newColumns.length);
        newColumns[indexToUpdate] = generateColumn(newColumns[indexToUpdate].id + 100);
        return newColumns;
      });
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="matrix-rain">
      {columns.map((column) => (
        <RainColumnComponent key={column.id} column={column} />
      ))}
    </div>
  );
});

MatrixRain.displayName = "MatrixRain";

export default MatrixRain;
