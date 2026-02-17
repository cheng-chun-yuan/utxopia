export type ClaimStep = "input" | "verifying" | "claiming" | "success" | "error";

export type ClaimProgress =
  | "idle"
  | "generating_proof"
  | "submitting"
  | "relaying"
  | "confirming"
  | "complete";

export interface VerifyResult {
  commitment: string;
  nullifierHash: string;
  amountSats: number;
}

export interface ClaimResult {
  txSignature: string;
  claimedAmount: number;
  merkleRoot?: string;
  leafIndex?: number;
  proofStatus?: string;
}

export interface SplitResult {
  keepLink: string;
  keepAmount: number;
  sendLink: string;
  sendAmount: number;
}
