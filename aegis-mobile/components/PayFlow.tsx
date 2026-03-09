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
import { Button, Input, AmountDisplay } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { formatSats, truncateAddress } from "@/lib/utils";

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

function BackRow({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.backRow}>
      <ArrowLeft size={18} color={Colors.grayLight} />
      <Text style={styles.backLabel}>Back</Text>
    </Pressable>
  );
}

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

  const [recipientInput, setRecipientInput] = useState("");
  const [amountInput, setAmountInput] = useState("");

  const goBack = () => {
    reset();
    setRecipientInput("");
    setAmountInput("");
  };

  // -- Recipient --
  const renderRecipient = () => (
    <View style={styles.container}>
      <Text style={styles.heading}>Send zkBTC</Text>
      <Text style={styles.subtext}>
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
        onPress={() => setRecipient(recipientInput.trim())}
      >
        Next
      </Button>
    </View>
  );

  // -- Amount --
  const renderAmount = () => {
    const parsed = parseInt(amountInput, 10);
    const isValid = !isNaN(parsed) && parsed > 0;
    const btcEquiv = isValid ? formatSats(parsed) : null;
    const exceedsBalance = isValid && parsed > availableBalance;

    return (
      <View style={styles.container}>
        <BackRow onPress={goBack} />

        <View style={styles.spacerMd} />

        <Text style={styles.heading}>Amount</Text>
        <Text style={styles.subtext}>
          To {truncateAddress(recipient, 8)}
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
          <Text style={styles.btcEquiv}>= {btcEquiv} BTC</Text>
        )}

        <Text style={styles.balanceLabel}>
          Available: {formatSats(availableBalance)} BTC
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

  // -- Confirm --
  const renderConfirm = () => (
    <View style={styles.container}>
      <BackRow onPress={goBack} />

      <View style={styles.spacerMd} />

      <Text style={styles.heading}>Confirm</Text>

      <View style={styles.spacerLg} />

      <View style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Recipient</Text>
          <Text style={styles.summaryValue}>
            {truncateAddress(recipient, 10)}
          </Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Amount</Text>
          <AmountDisplay sats={amountSats} showSats />
        </View>
      </View>

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

  // -- Proving --
  const renderProving = () => (
    <View style={[styles.container, styles.centered]}>
      <ProofProgress progress={proofProgress} />
    </View>
  );

  // -- Submitting --
  const renderSubmitting = () => (
    <View style={[styles.container, styles.centered]}>
      <Loader size={44} color={Colors.privacy} />
      <Text style={styles.centeredLabel}>Submitting to Solana...</Text>
    </View>
  );

  // -- Success --
  const renderSuccess = () => {
    const solscanUrl = txSignature
      ? `https://solscan.io/tx/${txSignature}?cluster=devnet`
      : null;

    return (
      <View style={[styles.container, styles.centered]}>
        <CheckCircle2 size={56} color={Colors.success} />

        <Text style={styles.successTitle}>Sent!</Text>
        <Text style={styles.subtext}>
          {formatSats(amountSats)} BTC to {truncateAddress(recipient, 6)}
        </Text>

        {txSignature && (
          <Pressable
            onPress={() => { if (solscanUrl) Linking.openURL(solscanUrl); }}
            style={styles.txPill}
          >
            <Text style={styles.txPillText}>
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

  // -- Error --
  const renderError = () => (
    <View style={[styles.container, styles.centered]}>
      <View style={styles.errorCircle}>
        <Text style={styles.errorIcon}>!</Text>
      </View>
      <Text style={styles.errorTitle}>Transaction Failed</Text>
      <Text style={styles.subtext}>{error}</Text>

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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 16,
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    color: Colors.foreground,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  subtext: {
    color: Colors.gray,
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
  },
  btcEquiv: {
    color: Colors.btc,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 6,
  },
  balanceLabel: {
    color: Colors.gray,
    fontSize: 13,
    marginTop: 6,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
  },
  backLabel: {
    color: Colors.grayLight,
    fontSize: 14,
    fontWeight: "500",
  },

  // Summary
  summaryCard: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    padding: 16,
  },
  summaryRow: {
    paddingVertical: 8,
  },
  summaryLabel: {
    color: Colors.gray,
    fontSize: 12,
    fontWeight: "500",
    marginBottom: 4,
  },
  summaryValue: {
    color: Colors.foreground,
    fontSize: 15,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
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
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: Colors.privacy,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(20, 241, 149, 0.06)",
  },
  progressText: {
    color: Colors.privacy,
    fontSize: 26,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  progressLabel: {
    color: Colors.gray,
    fontSize: 15,
    marginTop: 16,
  },
  centeredLabel: {
    color: Colors.gray,
    fontSize: 15,
    marginTop: 16,
  },

  // Success
  successTitle: {
    color: Colors.success,
    fontSize: 26,
    fontWeight: "700",
    marginTop: 12,
  },
  txPill: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Colors.secondary,
    borderRadius: 8,
  },
  txPillText: {
    color: Colors.privacy,
    fontSize: 13,
    fontFamily: "monospace",
  },

  // Error
  errorText: {
    color: Colors.error,
    fontSize: 14,
    marginTop: 4,
  },
  errorCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    borderColor: Colors.error,
    alignItems: "center",
    justifyContent: "center",
  },
  errorIcon: {
    color: Colors.error,
    fontSize: 32,
    fontWeight: "700",
  },
  errorTitle: {
    color: Colors.error,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 12,
  },

  // Spacers
  spacerSm: { height: 8 },
  spacerMd: { height: 16 },
  spacerLg: { height: 24 },
});
