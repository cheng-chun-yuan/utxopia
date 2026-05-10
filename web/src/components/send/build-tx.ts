import type { RecipientType } from "./recipient-detect";

export type SendIntentKind = "redeem" | "transact" | "unshield" | "claim_link";

export interface SendIntent {
  kind: SendIntentKind;
  recipientType: RecipientType | "claim_link";
  recipientValue: string;
  sourceToken: string;
  amount: string;
}

export interface BuildSendIntentInput {
  recipientType: RecipientType | "claim_link";
  recipientValue: string;
  sourceToken: string;
  amount: string;
}

/**
 * Pure dispatch: maps wizard state → which on-chain ix kind to build.
 * Caller threads the resulting `kind` to the right SDK builder.
 *
 * Validation is intentionally minimal — only the cross-field constraints
 * the wizard's own UI doesn't already enforce visually.
 */
export function buildSendIntent(input: BuildSendIntentInput): SendIntent {
  const { recipientType, sourceToken } = input;

  if (recipientType === "btc" && sourceToken !== "zkBTC") {
    throw new Error(
      "Bitcoin recipients can only receive zkBTC — pick zkBTC as the source token.",
    );
  }

  let kind: SendIntentKind;
  switch (recipientType) {
    case "btc":
      kind = "redeem";
      break;
    case "stealth_sns":
    case "stealth_meta":
      kind = "transact";
      break;
    case "spl_wallet":
      kind = "unshield";
      break;
    case "claim_link":
      kind = "claim_link";
      break;
  }

  return {
    kind,
    recipientType,
    recipientValue: input.recipientValue,
    sourceToken,
    amount: input.amount,
  };
}
