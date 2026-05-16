"use client";

import { useReducer, useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { Send, Link as LinkIcon, Loader2 } from "lucide-react";
import { detectRecipient, type RecipientType } from "./recipient-detect";
import { buildSendIntent } from "./build-tx";
import { RecipientInput } from "./recipient-input";
import { TokenSourcePicker } from "./token-source-picker";
import { AmountField } from "./amount-field";
import { FeeSummary } from "./fee-summary";
import { ReviewModal } from "./review-modal";
import { ClaimLinkModal, type ClaimLinkResult } from "./claim-link-modal";
import { useUTXOpia } from "@/hooks/use-utxopia";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useNoteAutoSelector } from "@/hooks/use-note-auto-selector";
import { useJoinSplitSubmit } from "@/hooks/use-joinsplit-submit";
import { useSnsName } from "@/hooks/use-sns-name";
import { useRelayerConfig } from "@/hooks/use-relayer-config";
import { buildTransferParams } from "@/hooks/use-build-transfer-params";
import { autoSelectNotes } from "@/components/send/_lifted/helpers";
import { PAY_TOKENS } from "@/lib/supported-tokens";
import { validateBtcAddress } from "@/components/ui/btc-address-input";
import { parseSats } from "@/lib/utils/validation";
import {
  decodeStealthMetaAddress,
  deriveMasterKey,
  deriveKeysFromSeedCircuit,
  createStealthMetaAddress,
  isAuditorDisclosable,
  type SnsStealthAddress,
  type StealthMetaAddress,
} from "@utxopia/sdk";

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

function generateClaimSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Render a 32-byte Solana pubkey as `abc…xyz` for compact UI display.
 *  Uses base58 via @solana/web3.js's PublicKey since the project already
 *  pulls that dep — avoids a separate `bs58` import. */
function bs58Truncated(bytes: Uint8Array): string {
  // Lazy require so the dep isn't pulled into the bundle if this code path
  // never executes for a given user session.
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { PublicKey } = require("@solana/web3.js") as typeof import("@solana/web3.js");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const b58 = new PublicKey(bytes).toBase58();
    return b58.length > 16 ? `${b58.slice(0, 6)}…${b58.slice(-6)}` : b58;
  } catch {
    // Fall back to hex if PublicKey balks for some reason.
    return Array.from(bytes.slice(0, 4), (b) => b.toString(16).padStart(2, "0"))
      .join("") +
      "…" +
      Array.from(bytes.slice(-4), (b) => b.toString(16).padStart(2, "0")).join("");
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

  const ctx = useUTXOpia();
  const { lookupSnsName } = useSnsName();
  const submitter = useJoinSplitSubmit();
  const { publicKey } = useWallet();
  const router = useRouter();
  const tokenPrices = useTokenPrices();
  const usdPerUnit = tokenPrices.btc ?? null;

  // Preview-resolve `.btcpro.sol` recipients so we can surface the
  // "auditor-disclosable" chip + block Send if the name doesn't exist.
  // Tri-state: idle (not an SNS input) / resolving / found / not_found.
  type SnsState =
    | { kind: "idle" }
    | { kind: "resolving" }
    | { kind: "found"; resolved: SnsStealthAddress }
    | { kind: "not_found" };
  const [snsState, setSnsState] = useState<SnsState>({ kind: "idle" });
  useEffect(() => {
    if (detection.type !== "stealth_sns") {
      setSnsState({ kind: "idle" });
      return;
    }
    const sub = state.recipient.trim().toLowerCase().replace(/\.btcpro\.sol$/, "");
    if (!sub) {
      setSnsState({ kind: "idle" });
      return;
    }
    setSnsState({ kind: "resolving" });
    let cancelled = false;
    void lookupSnsName(sub)
      .then((r) => {
        if (cancelled) return;
        setSnsState(r ? { kind: "found", resolved: r } : { kind: "not_found" });
      })
      .catch(() => {
        if (!cancelled) setSnsState({ kind: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [detection.type, state.recipient, lookupSnsName]);

  const resolvedSns = snsState.kind === "found" ? snsState.resolved : null;
  const showAuditorBadge = resolvedSns != null && isAuditorDisclosable(resolvedSns);

  const selectedPayToken = useMemo(
    () =>
      PAY_TOKENS.find((t) => t.shieldedSymbol === effectiveToken) ??
      PAY_TOKENS[0],
    [effectiveToken],
  );
  const { relayerMeta, effectiveRelayerFee } =
    useRelayerConfig(selectedPayToken);

  const amountSats = parseSats(state.amount) ?? 0;
  const totalNeeded = amountSats + effectiveRelayerFee;
  const noteSelector = useNoteAutoSelector(
    selectedPayToken.shieldedSymbol,
    totalNeeded,
  );

  const recipientValid =
    detection.type !== "empty" &&
    detection.type !== "invalid" &&
    detection.type !== "ambiguous" &&
    // SNS names must actually resolve on-chain before we let the rest of
    // the form unlock — otherwise the user wastes time picking notes for
    // a recipient that doesn't exist.
    (detection.type !== "stealth_sns" || snsState.kind === "found");

  // Narrowed alias used by JSX + buildSendIntent; only meaningful when
  // recipientValid is true (the JSX gates on that before reading it).
  const recipientType = detection.type as RecipientType;

  const amountNum = parseFloat(state.amount || "0");
  const amountValid = recipientValid && amountNum > 0;

  const totalAvailable = BigInt(noteSelector.totalAvailable);
  const isSubmittingInFlight =
    submitting ||
    (submitter.status !== "idle" &&
      submitter.status !== "success" &&
      submitter.status !== "error");

  // Re-fetch inbox + public balance shortly after a submit lands. Run on a
  // staggered schedule so we catch confirmation across slow RPC paths.
  const scheduleInboxRefresh = useCallback(() => {
    for (const delay of [2000, 5000, 10000]) {
      setTimeout(() => {
        ctx.refreshInbox(undefined, true);
        if (publicKey) ctx.refreshPublicBalance?.(publicKey);
      }, delay);
    }
  }, [ctx, publicKey]);

  const onSend = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      if (!ctx.keys || !ctx.stealthAddress) {
        throw new Error(
          "Vault locked. Sign in via the gear menu first.",
        );
      }

      const intent = buildSendIntent({
        recipientType,
        recipientValue: state.recipient.trim(),
        sourceToken: effectiveToken,
        amount: state.amount,
      });

      let mode: "stealth" | "public" | "btc";
      let recipientArg: {
        stealthMeta?: StealthMetaAddress;
        solanaAddress?: string;
        btcScriptPubKey?: Uint8Array;
      };

      switch (intent.kind) {
        case "redeem": {
          const v = validateBtcAddress(intent.recipientValue);
          if (!v.valid || !v.scriptPubKey) {
            throw new Error(v.error || "Invalid Bitcoin address");
          }
          mode = "btc";
          recipientArg = { btcScriptPubKey: v.scriptPubKey };
          break;
        }
        case "transact": {
          if (intent.recipientType === "stealth_sns") {
            const sub = intent.recipientValue
              .toLowerCase()
              .replace(/\.btcpro\.sol$/, "");
            const r = await lookupSnsName(sub);
            if (!r) {
              throw new Error(
                `Could not resolve ${intent.recipientValue}`,
              );
            }
            recipientArg = {
              stealthMeta: {
                spendingPubKey: new Uint8Array(32),
                viewingPubKey: r.viewingPubKey,
                mpk: r.mpk,
              } as StealthMetaAddress,
            };
          } else {
            recipientArg = {
              stealthMeta: decodeStealthMetaAddress(intent.recipientValue),
            };
          }
          mode = "stealth";
          break;
        }
        case "unshield": {
          mode = "public";
          recipientArg = { solanaAddress: intent.recipientValue };
          break;
        }
        case "claim_link":
          throw new Error(
            "Claim links are generated via the dedicated modal.",
          );
      }

      if (noteSelector.selectedNotes.length === 0) {
        throw new Error(
          "No shielded notes available to cover this amount.",
        );
      }

      const params = await buildTransferParams({
        mode,
        amountSats: BigInt(amountSats),
        selectedNotes: noteSelector.selectedNotes,
        keys: ctx.keys,
        selfMeta: ctx.stealthAddress,
        relayerMeta: relayerMeta?.stealthMeta
          ? decodeStealthMetaAddress(relayerMeta.stealthMeta)
          : undefined,
        relayerFee: effectiveRelayerFee,
        recipient: recipientArg,
      });

      await submitter.submit(params, BigInt(amountSats));
      scheduleInboxRefresh();

      dispatch({ type: "reset" });
      router.push("/vault/activity");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSubmitting(false);
    }
  }, [
    ctx,
    recipientType,
    state.recipient,
    state.amount,
    effectiveToken,
    lookupSnsName,
    noteSelector.selectedNotes,
    relayerMeta,
    effectiveRelayerFee,
    submitter,
    amountSats,
    router,
    scheduleInboxRefresh,
  ]);

  const onGenerateClaimLink = useCallback(
    async (input: {
      sourceToken: string;
      amount: string;
    }): Promise<ClaimLinkResult> => {
      if (!ctx.keys || !ctx.stealthAddress) {
        throw new Error(
          "Vault locked. Sign in via the gear menu first.",
        );
      }
      const sats = parseSats(input.amount);
      if (!sats || sats <= 0) {
        throw new Error("Enter a valid amount");
      }

      const phrase = generateClaimSecret();

      const noteMaster = deriveMasterKey(phrase);
      const noteKeys = await deriveKeysFromSeedCircuit(noteMaster);
      const noteMeta = createStealthMetaAddress(noteKeys);

      const totalNeededLink = sats + effectiveRelayerFee;
      const linkAvail = ctx.inboxNotes.filter(
        (n) =>
          n.amount > 0n &&
          !n.isSpent &&
          n.tokenSymbol === input.sourceToken,
      );
      const ids = autoSelectNotes(linkAvail, totalNeededLink);
      const linkSelected = linkAvail.filter((n) => ids.has(n.id));
      if (linkSelected.length === 0) {
        throw new Error(
          "No shielded notes available to cover this amount.",
        );
      }

      const params = await buildTransferParams({
        mode: "stealth",
        amountSats: BigInt(sats),
        selectedNotes: linkSelected,
        keys: ctx.keys,
        selfMeta: ctx.stealthAddress,
        relayerMeta: relayerMeta?.stealthMeta
          ? decodeStealthMetaAddress(relayerMeta.stealthMeta)
          : undefined,
        relayerFee: effectiveRelayerFee,
        recipient: { stealthMeta: noteMeta },
      });

      await submitter.submit(params, BigInt(sats));
      scheduleInboxRefresh();

      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const url = `${origin}/claim#note=${encodeURIComponent(phrase)}`;
      return { url, secret: phrase };
    },
    [ctx, relayerMeta, effectiveRelayerFee, submitter, scheduleInboxRefresh],
  );

  return (
    <div className="space-y-4">
      <RecipientInput
        value={state.recipient}
        onChange={(v) => dispatch({ type: "set_recipient", value: v })}
        snsStatus={snsState.kind}
      />

      {showAuditorBadge && (
        <div className="inline-flex flex-col items-start gap-1 px-3 py-1.5 rounded-lg border border-success/30 bg-success/5 text-[11px] text-success">
          <div className="inline-flex items-center gap-1.5 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Recipient is auditor-disclosable
          </div>
          {resolvedSns?.auditorPubkey && (
            <div className="font-mono text-[10px] text-success/80 break-all pl-3">
              auditor: {bs58Truncated(resolvedSns.auditorPubkey)}
            </div>
          )}
        </div>
      )}

      {recipientValid && (
        <>
          <TokenSourcePicker
            recipientType={recipientType}
            selected={effectiveToken}
            onSelect={(s) => dispatch({ type: "set_token", value: s })}
          />
          <AmountField
            value={state.amount}
            onChange={(v) => dispatch({ type: "set_amount", value: v })}
            decimals={selectedPayToken.decimals}
            unit={selectedPayToken.unit}
            availableBaseUnits={totalAvailable}
            usdPerUnit={usdPerUnit}
          />
        </>
      )}

      {amountValid && (
        <FeeSummary
          recipientType={recipientType}
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
        availableBaseUnits={totalAvailable}
        decimals={selectedPayToken.decimals}
        unit={selectedPayToken.unit}
        usdPerUnit={usdPerUnit}
        defaultToken={effectiveToken}
      />

      {isSubmittingInFlight && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          {submitter.statusMessage || "Submitting…"}
        </div>
      )}
    </div>
  );
}
