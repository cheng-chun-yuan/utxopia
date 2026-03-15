/**
 * Pay Flow — JoinSplit transaction UI for private transfers, unshields, and BTC redeems.
 *
 * Componentized into:
 * - helpers.ts: Constants, types, validation, note selection, field reduction
 * - proving-steps.tsx: Visual progress indicator for ZK proof generation
 * - note-links.tsx: Claim link preview and shareable link components
 * - output-row-card.tsx: Single output row with mode selector and recipient input
 * - ../pay-flow.tsx: Main PayFlow component (orchestrator with handlePay logic)
 */

export { PayFlow } from "../pay-flow";
