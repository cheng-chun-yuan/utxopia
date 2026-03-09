import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useAegisStore } from "@/stores/aegis-store";
import {
  useDepositStatus,
  type DepositStatus,
} from "@/hooks/use-deposit-status";
import { Button, Input, Card, CopyButton } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { formatSats, truncateAddress } from "@/lib/utils";
import {
  Clock,
  Search,
  ShieldCheck,
  CheckCircle2,
  CircleDot,
  ArrowLeft,
} from "lucide-react-native";

type DepositStep = "input" | "qr" | "tracking";

// ---------------------------------------------------------------------------
// Status step definitions
// ---------------------------------------------------------------------------

interface StatusStepDef {
  key: DepositStatus;
  label: string;
  icon: React.ElementType;
}

const STATUS_STEPS: StatusStepDef[] = [
  { key: "pending", label: "Waiting for payment", icon: Clock },
  { key: "detected", label: "Transaction detected", icon: Search },
  { key: "confirmed", label: "Confirmations received", icon: ShieldCheck },
  { key: "verified", label: "SPV verified on-chain", icon: CheckCircle2 },
  { key: "claimable", label: "Ready to claim!", icon: CheckCircle2 },
];

const STATUS_ORDER: DepositStatus[] = STATUS_STEPS.map((s) => s.key);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

  // Derived
  const parsedSats = parseInt(amountSats, 10);
  const isValidAmount = !isNaN(parsedSats) && parsedSats > 0;
  const btcAmount = isValidAmount ? (parsedSats / 1e8).toFixed(8) : "0.00000000";
  const bip21Uri = depositAddress
    ? `bitcoin:${depositAddress}?amount=${btcAmount}`
    : "";

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const generateAddress = async () => {
    if (!stealthMeta || !isValidAmount) return;
    setIsGenerating(true);
    setError(null);
    try {
      // Placeholder — will be wired to real SDK createNonInteractiveDeposit()
      // const deposit = await createNonInteractiveDeposit(stealthMeta, FROST_GROUP_PUBKEY);
      // setDepositAddress(deposit.btcAddress);
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

  const startTracking = () => {
    setStep("tracking");
  };

  const goBack = () => {
    if (step === "tracking") {
      setStep("qr");
    } else if (step === "qr") {
      setStep("input");
      setDepositAddress(null);
    }
  };

  // -------------------------------------------------------------------------
  // Render: Amount Input
  // -------------------------------------------------------------------------

  const renderAmountInput = () => (
    <View style={styles.stepContainer}>
      <Text style={styles.heading}>Deposit BTC</Text>
      <Text style={styles.subheading}>
        Send Bitcoin to a shielded Taproot address
      </Text>

      <View style={styles.spacerLg} />

      <Input
        label="Amount (sats)"
        placeholder="e.g. 50000"
        keyboardType="numeric"
        value={amountSats}
        onChangeText={setAmountSats}
      />

      {isValidAmount && (
        <Text style={styles.btcEquivalent}>
          = {btcAmount} BTC
        </Text>
      )}

      <View style={styles.spacerMd} />

      <Input
        label="Refund pubkey (optional)"
        placeholder="64 hex chars for 24h Taproot refund"
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
        Generate Deposit Address
      </Button>

      {!stealthMeta && (
        <Text style={styles.hint}>
          You need to set up your wallet first.
        </Text>
      )}
    </View>
  );

  // -------------------------------------------------------------------------
  // Render: QR Code Display
  // -------------------------------------------------------------------------

  const renderQR = () => (
    <View style={styles.stepContainer}>
      <Button variant="ghost" size="sm" onPress={goBack} className="self-start">
        <ArrowLeft size={18} color={Colors.grayLight} />
        <Text style={styles.backLabel}>Back</Text>
      </Button>

      <View style={styles.spacerMd} />

      <Card variant="btc" className="items-center p-6">
        <Text style={styles.qrTitle}>Scan to Deposit</Text>
        <View style={styles.spacerSm} />

        <View style={styles.qrWrapper}>
          <QRCode
            value={bip21Uri}
            size={220}
            backgroundColor="#ffffff"
            color="#000000"
          />
        </View>

        <View style={styles.spacerMd} />

        <Text style={styles.sendAmount}>
          Send exactly {btcAmount} BTC
        </Text>

        <View style={styles.addressRow}>
          <Text style={styles.addressText}>
            {truncateAddress(depositAddress!, 10)}
          </Text>
          <CopyButton text={depositAddress!} />
        </View>

        <Text style={styles.networkBadge}>Bitcoin Testnet4</Text>
      </Card>

      <View style={styles.spacerMd} />

      <CopyButton text={bip21Uri} label="Copy BIP-21 URI" />

      <View style={styles.spacerLg} />

      <Button variant="primary" size="lg" onPress={startTracking}>
        I've Sent the Payment
      </Button>
    </View>
  );

  // -------------------------------------------------------------------------
  // Render: Status Tracking
  // -------------------------------------------------------------------------

  const renderTracking = () => {
    const currentIndex = STATUS_ORDER.indexOf(depositStatus.status);

    return (
      <View style={styles.stepContainer}>
        <Button variant="ghost" size="sm" onPress={goBack} className="self-start">
          <ArrowLeft size={18} color={Colors.grayLight} />
          <Text style={styles.backLabel}>Back</Text>
        </Button>

        <View style={styles.spacerMd} />

        <Text style={styles.heading}>Deposit Status</Text>
        <Text style={styles.subheading}>
          Tracking {formatSats(parsedSats)} BTC deposit
        </Text>

        <View style={styles.spacerLg} />

        <Card variant="default">
          {STATUS_STEPS.map((s, i) => {
            const isCompleted = i < currentIndex;
            const isActive = i === currentIndex;
            const Icon = s.icon;

            const iconColor = isCompleted
              ? Colors.success
              : isActive
                ? Colors.privacy
                : Colors.gray;

            return (
              <View key={s.key} style={styles.statusRow}>
                {/* Vertical connector line */}
                {i > 0 && (
                  <View
                    style={[
                      styles.connector,
                      {
                        backgroundColor:
                          i <= currentIndex ? Colors.privacy : Colors.secondary,
                      },
                    ]}
                  />
                )}

                <View style={styles.statusIcon}>
                  {isCompleted ? (
                    <CheckCircle2 size={22} color={Colors.success} />
                  ) : isActive ? (
                    <CircleDot size={22} color={Colors.privacy} />
                  ) : (
                    <Icon size={22} color={Colors.gray} />
                  )}
                </View>

                <View style={styles.statusLabel}>
                  <Text
                    style={[
                      styles.statusText,
                      {
                        color: isActive
                          ? Colors.privacy
                          : isCompleted
                            ? Colors.success
                            : Colors.gray,
                        fontWeight: isActive ? "700" : "400",
                      },
                    ]}
                  >
                    {s.label}
                  </Text>
                  {isActive && s.key === "confirmed" && depositStatus.confirmations !== undefined && (
                    <Text style={styles.confirmCount}>
                      {depositStatus.confirmations} / 6 confirmations
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </Card>

        {depositStatus.status === "error" && (
          <View style={styles.spacerMd}>
            <Text style={styles.errorText}>
              {depositStatus.error || "Something went wrong"}
            </Text>
          </View>
        )}

        {depositStatus.txid && (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.hint}>
              txid: {truncateAddress(depositStatus.txid, 12)}
            </Text>
          </View>
        )}
      </View>
    );
  };

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------

  switch (step) {
    case "input":
      return renderAmountInput();
    case "qr":
      return renderQR();
    case "tracking":
      return renderTracking();
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  stepContainer: {
    flex: 1,
    paddingTop: 16,
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
  qrTitle: {
    color: Colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  qrWrapper: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 12,
  },
  sendAmount: {
    color: Colors.grayLight,
    fontSize: 15,
    fontWeight: "500",
  },
  addressRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  addressText: {
    color: Colors.gray,
    fontSize: 14,
    fontFamily: "monospace",
  },
  networkBadge: {
    color: Colors.btc,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 8,
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
    marginTop: 8,
  },
  errorText: {
    color: Colors.error,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 12,
  },

  // Status tracking
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    position: "relative",
  },
  connector: {
    position: "absolute",
    left: 10,
    top: 0,
    width: 2,
    height: 14,
  },
  statusIcon: {
    width: 28,
    alignItems: "center",
  },
  statusLabel: {
    marginLeft: 12,
    flex: 1,
  },
  statusText: {
    fontSize: 15,
  },
  confirmCount: {
    color: Colors.gray,
    fontSize: 12,
    marginTop: 2,
  },

  // Spacers
  spacerSm: { height: 8 },
  spacerMd: { height: 16 },
  spacerLg: { height: 24 },
});
