"use client";

import { useReducer, useState, useMemo } from "react";
import { Send, Link as LinkIcon, Loader2 } from "lucide-react";
import { detectRecipient } from "./recipient-detect";
import { buildSendIntent } from "./build-tx";
import { RecipientInput } from "./recipient-input";
import { TokenSourcePicker } from "./token-source-picker";
import { AmountField } from "./amount-field";
import { FeeSummary } from "./fee-summary";
import { ReviewModal } from "./review-modal";
import { ClaimLinkModal, type ClaimLinkResult } from "./claim-link-modal";
import { useTokenNotes } from "@/hooks/use-privacy-coin";
import { useTokenPrices } from "@/hooks/use-token-prices";

type Action =
  | { type: "set_recipient"; value: string }
  | { type: "set_token"; value: string }
  | { type: "set_amount"; value: string }
  | { type: "open_review" }
  | { type: "close_review" }
  | { type: "reset" };

type State = {
  recipient: string;
  sourceToken: string;
  amount: string;
  reviewOpen: boolean;
};

const initial: State = {
  recipient: "",
  sourceToken: "zkBTC",
  amount: "",
  reviewOpen: false,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set_recipient":
      return { ...state, recipient: action.value };
    case "set_token":
      return { ...state, sourceToken: action.value };
    case "set_amount":
      return { ...state, amount: action.value };
    case "open_review":
      return { ...state, reviewOpen: true };
    case "close_review":
      return { ...state, reviewOpen: false };
    case "reset":
      return initial;
  }
}

export function SendForm() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [linkOpen, setLinkOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detection = useMemo(
    () => detectRecipient(state.recipient),
    [state.recipient],
  );

  // For BTC recipient, force zkBTC source.
  const effectiveToken =
    detection.type === "btc" ? "zkBTC" : state.sourceToken;

  // Pull the user's shielded balance for the chosen token.
  const { totalBalance } = useTokenNotes(effectiveToken);
  const { prices } = useTokenPrices();
  // Phase 1 simplification: BTC-only USD preview.
  const usdPerUnit = prices?.btc ?? null;

  const recipientValid =
    detection.type !== "empty" &&
    detection.type !== "invalid" &&
    detection.type !== "ambiguous";

  const amountNum = parseFloat(state.amount || "0");
  const amountValid = recipientValid && amountNum > 0;

  const legacyPathFor = (
    kind: "redeem" | "transact" | "unshield" | "claim_link",
  ): string => {
    switch (kind) {
      case "redeem":
        return "/vault/pay/withdraw";
      case "transact":
        return "/vault/pay/transfer";
      case "unshield":
        return "/vault/pay/unshield";
      case "claim_link":
        return "/vault/pay/cashout";
    }
  };

  const onSend = () => {
    setError(null);
    setSubmitting(true);
    try {
      const intent = buildSendIntent({
        recipientType: detection.type as
          | "btc"
          | "stealth_sns"
          | "stealth_meta"
          | "spl_wallet",
        recipientValue: state.recipient.trim(),
        sourceToken: effectiveToken,
        amount: state.amount,
      });

      // Phase 1.5 will wire the SDK ix builders into this branch. For
      // now, surface a clear pointer to the still-live legacy path so
      // the user is never stranded.
      const legacy = legacyPathFor(intent.kind);
      setError(
        `Send is in preview — the unified flow ships in Phase 1.5. To complete this transaction today, use the legacy path: ${legacy}`,
      );
      dispatch({ type: "close_review" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Send failed";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onGenerateClaimLink = async (_input: {
    sourceToken: string;
    amount: string;
  }): Promise<ClaimLinkResult> => {
    throw new Error(
      "Claim-link generation is in preview — ships in Phase 1.5. Use /vault/pay/cashout for now.",
    );
  };

  return (
    <div className="space-y-4">
      <RecipientInput
        value={state.recipient}
        onChange={(v) => dispatch({ type: "set_recipient", value: v })}
      />

      {recipientValid && (
        <>
          <TokenSourcePicker
            recipientType={
              detection.type as "btc" | "stealth_sns" | "stealth_meta" | "spl_wallet"
            }
            selected={effectiveToken}
            onSelect={(s) => dispatch({ type: "set_token", value: s })}
          />
          <AmountField
            value={state.amount}
            onChange={(v) => dispatch({ type: "set_amount", value: v })}
            decimals={8}
            unit="BTC"
            availableBaseUnits={
              typeof totalBalance === "bigint"
                ? totalBalance
                : BigInt(totalBalance ?? 0)
            }
            usdPerUnit={usdPerUnit}
          />
        </>
      )}

      {amountValid && (
        <FeeSummary
          recipientType={
            detection.type as "btc" | "stealth_sns" | "stealth_meta" | "spl_wallet"
          }
          networkFeeLabel="≈ 120 sats"
          serviceFeeLabel="≈ 5 sats"
        />
      )}

      {error && <div className="text-xs text-red-500">{error}</div>}

      {amountValid && (
        <button
          type="button"
          onClick={() => dispatch({ type: "open_review" })}
          className="w-full px-4 py-3 rounded-lg bg-privacy text-background text-sm font-medium flex items-center justify-center gap-2"
        >
          <Send className="w-4 h-4" />
          Send
        </button>
      )}

      <div className="text-center text-xs text-muted-foreground">— or —</div>

      <button
        type="button"
        onClick={() => setLinkOpen(true)}
        className="w-full px-4 py-3 rounded-lg bg-muted/40 border border-gray/15 text-sm font-medium flex items-center justify-center gap-2 hover:border-privacy/30"
      >
        <LinkIcon className="w-4 h-4" />
        Send via claim link
      </button>

      <ReviewModal
        open={state.reviewOpen}
        onOpenChange={(o) =>
          dispatch({ type: o ? "open_review" : "close_review" })
        }
        recipientLabel={state.recipient.trim()}
        amountLabel={`${state.amount} ${effectiveToken}`}
        feeLabel="≈ 125 sats"
        warning={
          detection.type === "btc"
            ? "This will reveal your Bitcoin withdrawal address on-chain."
            : undefined
        }
        onConfirm={onSend}
      />

      <ClaimLinkModal
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onGenerate={onGenerateClaimLink}
        availableBaseUnits={
          typeof totalBalance === "bigint"
            ? totalBalance
            : BigInt(totalBalance ?? 0)
        }
        decimals={8}
        unit="BTC"
        usdPerUnit={usdPerUnit}
        defaultToken={effectiveToken}
      />

      {submitting && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          Submitting…
        </div>
      )}
    </div>
  );
}
