import React from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  Linking,
} from "react-native";
import { ScreenContainer, Button, Spinner } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { formatSats, truncateAddress } from "@/lib/utils";
import { useClaim, type ClaimableDeposit } from "@/hooks/use-claim";
import { CheckCircle, AlertCircle, Inbox } from "lucide-react-native";

function ProofProgress({ progress }: { progress: number }) {
  return (
    <View style={styles.progressContainer}>
      <View style={styles.progressBarBg}>
        <View
          style={[
            styles.progressBarFill,
            { width: `${Math.round(progress * 100)}%` },
          ]}
        />
      </View>
      <Text style={styles.progressText}>
        Generating proof... {Math.round(progress * 100)}%
      </Text>
    </View>
  );
}

function DepositRow({
  deposit,
  onClaim,
  isClaiming,
}: {
  deposit: ClaimableDeposit;
  onClaim: () => void;
  isClaiming: boolean;
}) {
  return (
    <View style={styles.depositRow}>
      <View style={styles.depositInfo}>
        <Text style={styles.depositAmount}>
          {formatSats(deposit.amount)} BTC
        </Text>
        <Text style={styles.depositMeta}>
          Leaf #{deposit.leafIndex}
        </Text>
      </View>
      <Button
        size="sm"
        variant="primary"
        onPress={onClaim}
        disabled={isClaiming}
        loading={isClaiming}
      >
        Claim
      </Button>
    </View>
  );
}

export default function ClaimScreen() {
  const { claimable, step, proofProgress, txSignature, error, claim, reset } =
    useClaim();

  const isClaiming = step === "proving" || step === "submitting";

  if (step === "success") {
    return (
      <ScreenContainer>
        <View style={styles.centered}>
          <CheckCircle size={56} color={Colors.success} />
          <Text style={styles.resultTitle}>Deposit Claimed</Text>
          <Text style={styles.resultSub}>
            Your zkBTC is now in your shielded balance.
          </Text>
          {txSignature && txSignature !== "placeholder_claim_sig" && (
            <Pressable
              onPress={() =>
                Linking.openURL(
                  `https://solscan.io/tx/${txSignature}?cluster=devnet`
                )
              }
              style={styles.txPill}
            >
              <Text style={styles.txPillText}>View on Solscan</Text>
            </Pressable>
          )}
          <View style={{ height: 24 }} />
          <Button variant="secondary" onPress={reset}>
            Done
          </Button>
        </View>
      </ScreenContainer>
    );
  }

  if (step === "error") {
    return (
      <ScreenContainer>
        <View style={styles.centered}>
          <AlertCircle size={56} color={Colors.error} />
          <Text style={[styles.resultTitle, { color: Colors.error }]}>
            Claim Failed
          </Text>
          <Text style={styles.resultSub}>{error}</Text>
          <View style={{ height: 24 }} />
          <Button variant="secondary" onPress={reset}>
            Try Again
          </Button>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <Text style={styles.heading}>Claim Deposits</Text>

      {step === "proving" && <ProofProgress progress={proofProgress} />}

      {step === "submitting" && (
        <View style={styles.submittingRow}>
          <Spinner size="sm" />
          <Text style={styles.submittingText}>Submitting...</Text>
        </View>
      )}

      {claimable.length === 0 && step === "idle" ? (
        <View style={styles.emptyState}>
          <Inbox size={40} color={Colors.gray} />
          <Text style={styles.emptyTitle}>No deposits to claim</Text>
          <Text style={styles.emptySub}>
            Deposits appear here after BTC confirmation.
          </Text>
        </View>
      ) : (
        <FlatList
          data={claimable}
          keyExtractor={(item) => item.commitment}
          renderItem={({ item }) => (
            <DepositRow
              deposit={item}
              onClaim={() => claim(item)}
              isClaiming={isClaiming}
            />
          )}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 24,
    fontWeight: "700",
    color: Colors.foreground,
    marginBottom: 16,
    marginTop: 8,
    letterSpacing: -0.3,
  },
  list: {
    paddingBottom: 32,
  },
  depositRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  depositInfo: {
    flex: 1,
    marginRight: 12,
  },
  depositAmount: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.foreground,
  },
  depositMeta: {
    fontSize: 12,
    color: Colors.gray,
    marginTop: 2,
  },
  progressContainer: {
    marginBottom: 16,
  },
  progressBarBg: {
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.secondary,
    overflow: "hidden",
  },
  progressBarFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.privacy,
  },
  progressText: {
    fontSize: 13,
    color: Colors.privacy,
    marginTop: 6,
    textAlign: "center",
  },
  submittingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    gap: 8,
  },
  submittingText: {
    fontSize: 14,
    color: Colors.grayLight,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  resultTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.success,
    marginTop: 16,
  },
  resultSub: {
    fontSize: 14,
    color: Colors.gray,
    marginTop: 6,
    textAlign: "center",
  },
  txPill: {
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Colors.secondary,
    borderRadius: 8,
  },
  txPillText: {
    color: Colors.privacy,
    fontSize: 13,
    fontWeight: "500",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.grayLight,
  },
  emptySub: {
    fontSize: 13,
    color: Colors.gray,
    textAlign: "center",
  },
});
