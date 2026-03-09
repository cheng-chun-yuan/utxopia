import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useAegisStore } from "@/stores/aegis-store";
import {
  useDepositStatus,
  type DepositStatus,
} from "@/hooks/use-deposit-status";
import { Button, Input, CopyButton } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { formatSats, truncateAddress } from "@/lib/utils";
import {
  CheckCircle2,
  CircleDot,
  ArrowLeft,
  Circle,
} from "lucide-react-native";

type DepositStep = "input" | "qr" | "tracking";

interface StatusStepDef {
  key: DepositStatus;
  label: string;
}

const STATUS_STEPS: StatusStepDef[] = [
  { key: "pending", label: "Waiting for payment" },
  { key: "detected", label: "Transaction detected" },
  { key: "confirmed", label: "Confirmations received" },
  { key: "verified", label: "SPV verified on-chain" },
  { key: "claimable", label: "Ready to claim" },
];

const STATUS_ORDER: DepositStatus[] = STATUS_STEPS.map((s) => s.key);

export function QRDeposit() {
  const [step, setStep] = useState<DepositStep>("input");
  const [amountSats, setAmountSats] = useState("");
  const [refundPubkey, setRefundPubkey] = useState("");
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stealthMeta = useAegisStore((s) => s.stealthMeta);
  const depositStatus = useDepositStatus(
    step === "tracking" ? depositAddress : null
  );

  const parsedSats = parseInt(amountSats, 10);
  const isValidAmount = !isNaN(parsedSats) && parsedSats > 0;
  const btcAmount = isValidAmount ? (parsedSats / 1e8).toFixed(8) : "0.00000000";
  const bip21Uri = depositAddress
    ? `bitcoin:${depositAddress}?amount=${btcAmount}`
    : "";

  const generateAddress = async () => {
    if (!stealthMeta || !isValidAmount) return;
    setIsGenerating(true);
    setError(null);
    try {
      setDepositAddress("tb1pksj664hdqkzvw2tlfvqshnevxt2qdutk47p9z964dkcsxazmf0vsjas4n4");
      setStep("qr");
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to generate deposit address";
      setError(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  const startTracking = () => setStep("tracking");

  const goBack = () => {
    if (step === "tracking") {
      setStep("qr");
    } else if (step === "qr") {
      setStep("input");
      setDepositAddress(null);
    }
  };

  // -- Input Step --
  const renderAmountInput = () => (
    <View style={styles.container}>
      <Text style={styles.heading}>Deposit BTC</Text>

      <View style={styles.spacerLg} />

      <Input
        label="Amount (sats)"
        placeholder="e.g. 50000"
        keyboardType="numeric"
        value={amountSats}
        onChangeText={setAmountSats}
      />

      {isValidAmount && (
        <Text style={styles.btcEquiv}>= {btcAmount} BTC</Text>
      )}

      <View style={styles.spacerMd} />

      <Input
        label="Refund pubkey (optional)"
        placeholder="64 hex chars"
        value={refundPubkey}
        onChangeText={setRefundPubkey}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <View style={styles.spacerLg} />

      {error && <Text style={styles.errorText}>{error}</Text>}

      <Button
        variant="bitcoin"
        size="lg"
        loading={isGenerating}
        disabled={!isValidAmount || !stealthMeta}
        onPress={generateAddress}
      >
        Generate Address
      </Button>

      {!stealthMeta && (
        <Text style={styles.hint}>Set up your wallet first.</Text>
      )}
    </View>
  );

  // -- QR Step --
  const renderQR = () => (
    <View style={styles.container}>
      <Pressable onPress={goBack} style={styles.backRow}>
        <ArrowLeft size={18} color={Colors.grayLight} />
        <Text style={styles.backLabel}>Back</Text>
      </Pressable>

      <View style={styles.spacerLg} />

      {/* QR centered */}
      <View style={styles.qrCenter}>
        <View style={styles.qrBg}>
          <QRCode
            value={bip21Uri}
            size={240}
            backgroundColor="#ffffff"
            color="#000000"
          />
        </View>

        <View style={styles.spacerMd} />

        <Text style={styles.sendLabel}>
          Send {btcAmount} BTC
        </Text>

        <View style={styles.addressCopyRow}>
          <Text style={styles.addressMono}>
            {truncateAddress(depositAddress!, 10)}
          </Text>
          <CopyButton text={depositAddress!} iconSize={14} />
        </View>

        <Text style={styles.networkLabel}>Bitcoin Testnet4</Text>
      </View>

      <View style={styles.spacerLg} />

      <CopyButton text={bip21Uri} label="Copy BIP-21 URI" />

      <View style={styles.spacerMd} />

      <Button variant="primary" size="lg" onPress={startTracking}>
        I've Sent the Payment
      </Button>
    </View>
  );

  // -- Tracking Step --
  const renderTracking = () => {
    const currentIndex = STATUS_ORDER.indexOf(depositStatus.status);

    return (
      <View style={styles.container}>
        <Pressable onPress={goBack} style={styles.backRow}>
          <ArrowLeft size={18} color={Colors.grayLight} />
          <Text style={styles.backLabel}>Back</Text>
        </Pressable>

        <View style={styles.spacerMd} />

        <Text style={styles.heading}>Deposit Status</Text>
        <Text style={styles.subtext}>
          Tracking {formatSats(parsedSats)} BTC
        </Text>

        <View style={styles.spacerLg} />

        {STATUS_STEPS.map((s, i) => {
          const isCompleted = i < currentIndex;
          const isActive = i === currentIndex;

          return (
            <View key={s.key} style={styles.statusRow}>
              <View style={styles.statusDotCol}>
                {isCompleted ? (
                  <CheckCircle2 size={18} color={Colors.success} />
                ) : isActive ? (
                  <CircleDot size={18} color={Colors.privacy} />
                ) : (
                  <Circle size={18} color={Colors.secondary} />
                )}
                {i < STATUS_STEPS.length - 1 && (
                  <View
                    style={[
                      styles.connector,
                      {
                        backgroundColor:
                          i < currentIndex ? Colors.privacy : Colors.secondary,
                      },
                    ]}
                  />
                )}
              </View>
              <View style={styles.statusLabelCol}>
                <Text
                  style={[
                    styles.statusText,
                    {
                      color: isActive
                        ? Colors.privacy
                        : isCompleted
                          ? Colors.success
                          : Colors.gray,
                      fontWeight: isActive ? "600" : "400",
                    },
                  ]}
                >
                  {s.label}
                </Text>
                {isActive && s.key === "confirmed" && depositStatus.confirmations !== undefined && (
                  <Text style={styles.confirmCount}>
                    {depositStatus.confirmations}/6 confirmations
                  </Text>
                )}
              </View>
            </View>
          );
        })}

        {depositStatus.status === "error" && (
          <Text style={styles.errorText}>
            {depositStatus.error || "Something went wrong"}
          </Text>
        )}

        {depositStatus.txid && (
          <Text style={styles.hint}>
            txid: {truncateAddress(depositStatus.txid, 12)}
          </Text>
        )}
      </View>
    );
  };

  switch (step) {
    case "input":
      return renderAmountInput();
    case "qr":
      return renderQR();
    case "tracking":
      return renderTracking();
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 16,
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
  },
  btcEquiv: {
    color: Colors.btc,
    fontSize: 14,
    fontWeight: "600",
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
  hint: {
    color: Colors.gray,
    fontSize: 13,
    textAlign: "center",
    marginTop: 12,
  },
  errorText: {
    color: Colors.error,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 12,
  },

  // QR
  qrCenter: {
    alignItems: "center",
  },
  qrBg: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
  },
  sendLabel: {
    color: Colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  addressCopyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  addressMono: {
    color: Colors.gray,
    fontSize: 13,
    fontFamily: "monospace",
  },
  networkLabel: {
    color: Colors.btc,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 8,
  },

  // Status tracking
  statusRow: {
    flexDirection: "row",
    minHeight: 44,
  },
  statusDotCol: {
    width: 24,
    alignItems: "center",
  },
  connector: {
    width: 2,
    flex: 1,
    marginVertical: 2,
  },
  statusLabelCol: {
    marginLeft: 12,
    paddingBottom: 12,
    flex: 1,
  },
  statusText: {
    fontSize: 14,
  },
  confirmCount: {
    color: Colors.gray,
    fontSize: 12,
    marginTop: 2,
  },

  // Spacers
  spacerMd: { height: 16 },
  spacerLg: { height: 24 },
});
