/**
 * Canonical deposit status definitions — shared across explorer and vault widgets.
 *
 * Status lifecycle: pending → detected → confirming → confirmed → sweeping →
 * sweep_confirming → verifying → ready/claimed
 */

/** Deposit lifecycle step ordering (higher = further along) */
export const DEPOSIT_STATUS_ORDER: Record<string, number> = {
  pending: 0,
  detected: 1,
  confirming: 1,
  confirmed: 2,
  sweeping: 3,
  sweep_confirming: 3,
  verifying: 4,
  ready: 5,
  claimed: 5,
};

/** Withdrawal lifecycle step ordering */
export const WITHDRAWAL_STATUS_ORDER: Record<string, number> = {
  Pending: 0,
  pending: 0,
  Detected: 1,
  processing: 1,
  Processing: 1,
  Signing: 2,
  sending: 2,
  AwaitingConfirmation: 3,
  sent: 3,
  confirming: 3,
  SpvVerified: 3,
  completed: 4,
  Completed: 4,
  Cancelled: -1,
  Failed: -1,
  failed: -1,
};

export type DepositStatus =
  | "pending"
  | "detected"
  | "confirming"
  | "confirmed"
  | "sweeping"
  | "sweep_confirming"
  | "verifying"
  | "ready"
  | "claimed"
  | "failed";

/** UI config for deposit status display */
export interface StatusDisplayConfig {
  label: string;
  color: string;
  bg: string;
  spinning?: boolean;
}

/** Explorer-style deposit status config (Tailwind -400 colors) */
export const DEPOSIT_STATUS_CONFIG: Record<string, StatusDisplayConfig> = {
  pending: { label: "Awaiting BTC", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  detected: { label: "Detected", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20", spinning: true },
  confirming: { label: "Confirming", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20", spinning: true },
  confirmed: { label: "Confirmed", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
  sweeping: { label: "Sweeping", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  sweep_confirming: { label: "Sweep Confirming", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  verifying: { label: "Verifying", color: "text-sol", bg: "bg-sol/10 border-sol/20", spinning: true },
  ready: { label: "Minted", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  claimed: { label: "Minted", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  failed: { label: "Failed", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
};

/** Explorer-style withdrawal status config */
export const WITHDRAWAL_STATUS_CONFIG: Record<string, StatusDisplayConfig> = {
  Pending: { label: "Pending", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  Detected: { label: "Detected", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  Processing: { label: "Processing", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  Signing: { label: "Signing", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20", spinning: true },
  AwaitingConfirmation: { label: "Confirming", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20", spinning: true },
  SpvVerified: { label: "Verified", color: "text-cyan-400", bg: "bg-cyan-500/10 border-cyan-500/20", spinning: true },
  Completed: { label: "Completed", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  Cancelled: { label: "Cancelled", color: "text-gray", bg: "bg-gray/10 border-gray/20" },
  Failed: { label: "Failed", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
};
