import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, Linking } from "react-native";
import {
  ArrowLeft,
  CheckCircle2,
  Send,
  Loader,
} from "lucide-react-native";
import { useSend, type SendStep } from "@/hooks/use-send";
import { useAegisStore } from "@/stores/aegis-store";
import { Button, Input, Card, AmountDisplay } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { formatSats, truncateAddress } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Circular Progress (simple SVG-free approach for proof step)
// ---------------------------------------------------------------------------

function ProofProgress({ progress }: { progress: number }) {
  const pct = Math.round(progress * 100);
  return (
    <View style={styles.progressContainer}>
      <View style={styles.progressCircle}>
        <Text style={styles.progressText}>{pct}%</Text>
      </View>
      <Text style={styles.progressLabel}>Generating ZK Proof...</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// PayFlow Component
// ---------------------------------------------------------------------------

export function PayFlow() {
  const {
    step,
    recipient,
    amountSats,
    txSignature,
    error,
    proofProgress,
    setRecipient,
    setAmount,
    confirm,
    reset,
  } = useSend();

  const inboxNotes = useAegisStore((s) => s.inboxNotes);
  const availableBalance = inboxNotes
    .filter((n) => !n.spent)
    .reduce((sum, n) => sum + n.amount, 0);

  // Local input state
  const [recipientInput, setRecipientInput] = useState("");
  const [amountInput, setAmountInput] = useState("");

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  const canGoBack = (s: SendStep) =>
    s === "amount" || s === "confirm";

  const goBack = () => {
    // Reset and start over (simple approach)
    reset();
    setRecipientInput("");
    setAmountInput("");
  };

  // -------------------------------------------------------------------------
  // Recipient Step
  // -------------------------------------------------------------------------

  const renderRecipient = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.heading}>Send zkBTC</Text>
      <Text style={styles.subheading}>
        Enter a .btcpro.sol name or stealth address
      </Text>

      <View style={styles.spacerLg} />

      <Input
        label="Recipient"
        placeholder="alice.btcpro.sol or stealth address"
        value={recipientInput}
        onChangeText={setRecipientInput}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.spacerLg} />

      <Button
        variant="primary"
        size="lg"
        disabled={recipientInput.trim().length === 0}
        onPress={() => {
          setRecipient(recipientInput.trim());
        }}
      >
        Next
      </Button>
    </View>
  );

  // -------------------------------------------------------------------------
  // Amount Step
  // -------------------------------------------------------------------------

  const renderAmount = () => {
    const parsed = parseInt(amountInput, 10);
    const isValid = !isNaN(parsed) && parsed > 0;
    const btcEquiv = isValid ? formatSats(parsed) : null;
    const exceedsBalance = isValid && parsed > availableBalance;

    return (
      <View style={styles.stepContainer}>
        <BackButton onPress={goBack} />

        <View style={styles.spacerMd} />

        <Text style={styles.heading}>Amount</Text>
        <Text style={styles.subheading}>
          Sending to {truncateAddress(recipient, 8)}
        </Text>

        <View style={styles.spacerLg} />

        <Input
          label="Amount (sats)"
          placeholder="e.g. 10000"
          keyboardType="numeric"
          value={amountInput}
          onChangeText={setAmountInput}
        />

        {btcEquiv && (
          <Text style={styles.btcEquivalent}>= {btcEquiv} BTC</Text>
        )}

        <View style={styles.spacerSm} />

        <Text style={styles.balanceLabel}>
          Available: {formatSats(availableBalance)} BTC (
          {availableBalance.toLocaleString()} sats)
        </Text>

        {exceedsBalance && (
          <Text style={styles.errorText}>Insufficient balance</Text>
        )}

        <View style={styles.spacerLg} />

        <Button
          variant="primary"
          size="lg"
          disabled={!isValid || exceedsBalance}
          onPress={() => setAmount(parsed)}
        >
          Next
        </Button>
      </View>
    );
  };

  // -------------------------------------------------------------------------
  // Confirm Step
  // -------------------------------------------------------------------------

  const renderConfirm = () => (
    <View style={styles.stepContainer}>
      <BackButton onPress={goBack} />

      <View style={styles.spacerMd} />

      <Text style={styles.heading}>Confirm Send</Text>

      <View style={styles.spacerLg} />

      <Card variant="privacy">
        <Text style={styles.confirmLabel}>Recipient</Text>
        <Text style={styles.confirmValue}>
          {truncateAddress(recipient, 10)}
        </Text>

        <View style={styles.spacerMd} />

        <Text style={styles.confirmLabel}>Amount</Text>
        <AmountDisplay sats={amountSats} showSats />
      </Card>

      <View style={styles.spacerLg} />

      <Button variant="primary" size="lg" onPress={confirm}>
        <Send size={18} color={Colors.background} />
        <Text style={styles.sendButtonText}>Send</Text>
      </Button>

      <View style={styles.spacerSm} />

      <Button variant="ghost" size="md" onPress={goBack}>
        Cancel
      </Button>
    </View>
  );

  // -------------------------------------------------------------------------
  // Proving Step
  // -------------------------------------------------------------------------

  const renderProving = () => (
    <View style={[styles.stepContainer, styles.centeredStep]}>
      <ProofProgress progress={proofProgress} />
    </View>
  );

  // -------------------------------------------------------------------------
  // Submitting Step
  // -------------------------------------------------------------------------

  const renderSubmitting = () => (
    <View style={[styles.stepContainer, styles.centeredStep]}>
      <Loader size={48} color={Colors.privacy} />
      <View style={styles.spacerMd} />
      <Text style={styles.submittingLabel}>Submitting to Solana...</Text>
    </View>
  );

  // -------------------------------------------------------------------------
  // Success Step
  // -------------------------------------------------------------------------

  const renderSuccess = () => {
    const solscanUrl = txSignature
      ? `https://solscan.io/tx/${txSignature}?cluster=devnet`
      : null;

    return (
      <View style={[styles.stepContainer, styles.centeredStep]}>
        <CheckCircle2 size={64} color={Colors.success} />

        <View style={styles.spacerMd} />

        <Text style={styles.successTitle}>Sent!</Text>
        <Text style={styles.successSub}>
          {formatSats(amountSats)} BTC sent to{" "}
          {truncateAddress(recipient, 6)}
        </Text>

        {txSignature && (
          <Pressable
            onPress={() => {
              if (solscanUrl) Linking.openURL(solscanUrl);
            }}
            style={styles.txLink}
          >
            <Text style={styles.txLinkText}>
              {truncateAddress(txSignature, 8)}
            </Text>
          </Pressable>
        )}

        <View style={styles.spacerLg} />

        <Button variant="primary" size="lg" onPress={() => {
          reset();
          setRecipientInput("");
          setAmountInput("");
        }}>
          Done
        </Button>
      </View>
    );
  };

  // -------------------------------------------------------------------------
  // Error Step
  // -------------------------------------------------------------------------

  const renderError = () => (
    <View style={[styles.stepContainer, styles.centeredStep]}>
      <Text style={styles.errorIcon}>!</Text>
      <View style={styles.spacerMd} />
      <Text style={styles.errorTitle}>Transaction Failed</Text>
      <Text style={styles.errorDetail}>{error}</Text>

      <View style={styles.spacerLg} />

      <Button variant="primary" size="lg" onPress={() => {
        reset();
        setRecipientInput("");
        setAmountInput("");
      }}>
        Try Again
      </Button>
    </View>
  );

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  switch (step) {
    case "recipient":
      return renderRecipient();
    case "amount":
      return renderAmount();
    case "confirm":
      return renderConfirm();
    case "proving":
      return renderProving();
    case "submitting":
      return renderSubmitting();
    case "success":
      return renderSuccess();
    case "error":
      return renderError();
  }
}

// ---------------------------------------------------------------------------
// BackButton helper
// ---------------------------------------------------------------------------

function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Button variant="ghost" size="sm" onPress={onPress} className="self-start">
      <ArrowLeft size={18} color={Colors.grayLight} />
      <Text style={styles.backLabel}>Back</Text>
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  stepContainer: {
    flex: 1,
    paddingTop: 16,
  },
  centeredStep: {
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    color: Colors.foreground,
    fontSize: 24,
    fontWeight: "700",
  },
  subheading: {
    color: Colors.grayLight,
    fontSize: 15,
    marginTop: 4,
  },
  btcEquivalent: {
    color: Colors.btc,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 6,
  },
  balanceLabel: {
    color: Colors.gray,
    fontSize: 13,
    marginTop: 4,
  },
  backLabel: {
    color: Colors.grayLight,
    fontSize: 14,
    fontWeight: "500",
  },

  // Confirm
  confirmLabel: {
    color: Colors.gray,
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 4,
  },
  confirmValue: {
    color: Colors.foreground,
    fontSize: 16,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  sendButtonText: {
    color: Colors.background,
    fontSize: 16,
    fontWeight: "700",
  },

  // Progress
  progressContainer: {
    alignItems: "center",
  },
  progressCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 4,
    borderColor: Colors.privacy,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(20, 241, 149, 0.08)",
  },
  progressText: {
    color: Colors.privacy,
    fontSize: 28,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  progressLabel: {
    color: Colors.grayLight,
    fontSize: 16,
    fontWeight: "500",
    marginTop: 16,
  },

  // Submitting
  submittingLabel: {
    color: Colors.grayLight,
    fontSize: 16,
    fontWeight: "500",
  },

  // Success
  successTitle: {
    color: Colors.success,
    fontSize: 28,
    fontWeight: "700",
  },
  successSub: {
    color: Colors.grayLight,
    fontSize: 15,
    marginTop: 4,
    textAlign: "center",
  },
  txLink: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Colors.secondary,
    borderRadius: 8,
  },
  txLinkText: {
    color: Colors.privacy,
    fontSize: 14,
    fontFamily: "monospace",
  },

  // Error
  errorText: {
    color: Colors.error,
    fontSize: 14,
    marginTop: 4,
  },
  errorIcon: {
    color: Colors.error,
    fontSize: 48,
    fontWeight: "700",
    width: 80,
    height: 80,
    lineHeight: 80,
    textAlign: "center",
    borderRadius: 40,
    borderWidth: 3,
    borderColor: Colors.error,
    overflow: "hidden",
  },
  errorTitle: {
    color: Colors.error,
    fontSize: 22,
    fontWeight: "700",
  },
  errorDetail: {
    color: Colors.grayLight,
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
  },

  // Spacers
  spacerSm: { height: 8 },
  spacerMd: { height: 16 },
  spacerLg: { height: 24 },
});
