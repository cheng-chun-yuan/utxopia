export const Colors = {
  background: "#0f0f12",
  foreground: "#f1f0f3",
  card: "#202027",
  muted: "#16161b",
  secondary: "#2c2c36",
  gray: "#8b8a9e",
  grayLight: "#c7c5d1",
  btc: "#f7931a",
  privacy: "#14f195",
  sol: "#9945ff",
  purple: "#ffabfe",
  success: "#4ade80",
  warning: "#ffb546",
  error: "#ef4444",
  cyan: "#00ffff",
  border: "rgba(139, 138, 158, 0.2)",
} as const;

export type ColorName = keyof typeof Colors;
