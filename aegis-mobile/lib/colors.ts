export const Colors = {
  // Core
  background: "#0a0a0f",
  foreground: "#f1f0f3",
  card: "#141419",
  cardHover: "#1a1a22",
  muted: "#111116",
  secondary: "#1e1e28",

  // Grays
  gray: "#6b6b7b",
  grayLight: "#a3a3b5",

  // Accent — mint green (privacy)
  accent: "#14f195",
  accentMuted: "rgba(20, 241, 149, 0.08)",
  accentSoft: "rgba(20, 241, 149, 0.15)",

  // Brand colors
  btc: "#f7931a",
  btcMuted: "rgba(247, 147, 26, 0.10)",
  privacy: "#14f195",
  sol: "#9945ff",
  solMuted: "rgba(153, 69, 255, 0.10)",

  // Status
  success: "#4ade80",
  warning: "#ffb546",
  error: "#ef4444",

  // Borders
  border: "rgba(255, 255, 255, 0.06)",
  borderLight: "rgba(255, 255, 255, 0.10)",
} as const;

export type ColorName = keyof typeof Colors;
