// API Request/Response Types for zVault (zkBTC)
//
// Simplified Flow:
// 1. User generates: nullifier + secret
// 2. User computes: commitment = Hash(nullifier, secret)
// 3. POST /api/deposit/prepare with commitment -> taproot address
// 4. User sends BTC to taproot address
// 5. Relayer detects BTC, records (commitment, amount) on-chain
// 6. User claims with nullifier + secret, amount looked up on-chain

export interface PrepareDepositRequest {
  commitment: string; // Hash(nullifier, secret)
  solana_address?: string;
}

export interface PrepareDepositResponse {
  taproot_address: string;
  commitment: string;
  expires_at: number;
}

export type EscrowStatus =
  | "waiting_payment"
  | "confirming"
  | "screening"
  | "passed"
  | "blocked"
  | "in_custody"
  | "minted"
  | "refunded"
  | "expired";

export type ScreeningStatus = "pending" | "screening" | "passed" | "blocked";

export interface ScreeningInfo {
  status: ScreeningStatus;
  checked_at?: number;
  risk_score: number;
  flags: string[];
  blocklist_match?: string;
}

export interface DepositStatusResponse {
  found: boolean;
  taproot_address?: string;
  commitment?: string;
  amount_sats?: number; // Detected from BTC chain
  btc_txid?: string;
  confirmations: number;
  required_confirmations: number;
  status: string;
  escrow_status: EscrowStatus;
  screening?: ScreeningInfo;
  can_claim: boolean;
  claimed: boolean;
  refund_available: boolean;
  refund_available_at?: number;
}

// Blocklist management types (demo mode)
export interface BlocklistResponse {
  addresses: string[];
  prefixes: string[];
  demo_mode: boolean;
}

export interface ScreenAddressRequest {
  address: string;
}

export interface ScreenAddressResponse {
  address: string;
  status: ScreeningStatus;
  checked_at: number;
  risk_score: number;
  flags: string[];
  blocklist_match?: string;
}

// Simplified claim flow - no ZK proof needed for demo
export interface ClaimRequest {
  nullifier: string;
  secret: string;
  solana_address: string;
}

export interface ClaimResponse {
  success: boolean;
  commitment: string;
  nullifier_hash: string;
  amount_sats: number; // Looked up from on-chain record
  solana_txid?: string;
  merkle_root?: string;
  leaf_index?: number;
  proof_status?: string;
  error?: string;
}

// Verify claim would succeed without executing
export interface VerifyClaimRequest {
  nullifier: string;
  secret: string;
}

export interface VerifyClaimResponse {
  valid: boolean;
  commitment: string;
  nullifier_hash: string;
  amount_sats?: number;
  already_claimed: boolean;
  deposit_found: boolean;
  error?: string;
}

export interface BalanceResponse {
  solana_address: string;
  zkbtc_balance: number;
  pending_deposits: number;
  pending_withdrawals: number;
}

export interface RedeemRequest {
  amount_sats: number;
  btc_address: string;
  solana_address: string;
}

export interface RedeemResponse {
  success: boolean;
  request_id?: string;
  message?: string;
}

export interface WithdrawalStatusResponse {
  request_id: string;
  status: "pending" | "processing" | "broadcasting" | "completed" | "failed";
  amount_sats: number;
  btc_address: string;
  btc_txid?: string;
  created_at: number;
  completed_at?: number;
}

export interface StatsResponse {
  total_deposits: number;
  total_minted_sats: number;
  total_redeemed_sats: number;
  pending_deposits: number;
  pending_withdrawals: number;
  merkle_root: string;
  bitcoin_block_height: number;
}

export interface PoolInfoResponse {
  total_deposited: number;
  total_claimed: number;
  total_redeemed: number;
  active_deposits: number;
  merkle_root: string;
  deposit_count: number;
  nullifier_count: number;
}

export interface ApiError {
  error: string;
  details?: string;
}

// Note: User only needs to store nullifier + secret
// The claim link format: ?n=<nullifier>&s=<secret>
export interface NoteData {
  nullifier: string;
  secret: string;
}

// Legacy types for backwards compatibility
export interface MintRequest {
  note_export: string;
  solana_address: string;
}

export interface MintResponse {
  success: boolean;
  tx_signature?: string;
  zkbtc_amount?: number;
  message?: string;
}

// Verify deposit request - submit taproot address for verification
export interface VerifyDepositRequest {
  taproot_address: string;
  commitment?: string;
  expected_amount_sats?: number;
  solana_address?: string;
}

export interface VerifyDepositResponse {
  success: boolean;
  taproot_address: string;
  btc_txid?: string;
  amount_sats?: number;
  confirmations: number;
  required_confirmations: number;
  verified: boolean;
  recorded_on_chain: boolean;
  solana_tx_signature?: string;
  commitment?: string;
  can_claim: boolean;
  message?: string;
}

// Block header submission (relayer publishes on-chain)
export interface SubmitHeaderRequest {
  block_height: number;
  block_hash: string;
  raw_header: string; // 80-byte header in hex (160 chars)
  prev_block_hash: string;
  merkle_root: string;
  timestamp: number;
  bits: number;
  nonce: number;
}

export interface SubmitHeaderResponse {
  success: boolean;
  block_height: number;
  block_hash: string;
  solana_tx_signature?: string;
  already_exists?: boolean;
  message?: string;
  error?: string;
}

export interface HeaderStatusResponse {
  exists: boolean;
  block_height: number;
  block_hash?: string;
  submitted_at?: number;
  solana_tx_signature?: string;
}
