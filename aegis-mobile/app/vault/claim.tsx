import React from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Linking,
} from "react-native";
import { ScreenContainer, Card, Button, Spinner } from "@/components/ui";
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

function DepositCard({
  deposit,
  onClaim,
  isClaiming,
}: {
  deposit: ClaimableDeposit;
  onClaim: () => void;
  isClaiming: boolean;
}) {
  return (
    <Card variant="privacy" className="mb-3">
      <View style={styles.cardRow}>
        <View style={styles.cardInfo}>
          <Text style={styles.amountText}>
            {formatSats(deposit.amount)} BTC
          </Text>
          <Text style={styles.hashText}>
            {truncateAddress(deposit.commitment, 8)}
          </Text>
          <Text style={styles.leafText}>Leaf #{deposit.leafIndex}</Text>
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
    </Card>
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
          <CheckCircle size={64} color={Colors.success} />
          <Text style={styles.successTitle}>Deposit Claimed!</Text>
          <Text style={styles.successSubtitle}>
            Your zkBTC is now in your shielded balance.
          </Text>
          {txSignature && txSignature !== "placeholder_claim_sig" && (
            <Button
              variant="ghost"
              size="sm"
              onPress={() =>
                Linking.openURL(
                  `https://solscan.io/tx/${txSignature}?cluster=devnet`
                )
              }
              className="mt-4"
            >
              View on Solscan
            </Button>
          )}
          <Button variant="secondary" onPress={reset} className="mt-6">
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
          <AlertCircle size={64} color={Colors.error} />
          <Text style={styles.errorTitle}>Claim Failed</Text>
          <Text style={styles.errorSubtitle}>{error}</Text>
          <Button variant="secondary" onPress={reset} className="mt-6">
            Try Again
          </Button>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <Text style={styles.heading}>Claim Deposits</Text>
      <Text style={styles.subtitle}>
        Verified BTC deposits ready to claim as shielded zkBTC.
      </Text>

      {step === "proving" && <ProofProgress progress={proofProgress} />}

      {step === "submitting" && (
        <View style={styles.submittingRow}>
          <Spinner size="sm" />
          <Text style={styles.submittingText}>Submitting transaction...</Text>
        </View>
      )}

      {claimable.length === 0 && step === "idle" ? (
        <View style={styles.emptyState}>
          <Inbox size={48} color={Colors.gray} />
          <Text style={styles.emptyText}>No deposits to claim</Text>
          <Text style={styles.emptySubtext}>
            Deposits will appear here after BTC confirmation and SPV
            verification.
          </Text>
        </View>
      ) : (
        <FlatList
          data={claimable}
          keyExtractor={(item) => item.commitment}
          renderItem={({ item }) => (
            <DepositCard
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
    marginBottom: 4,
    marginTop: 8,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.gray,
    marginBottom: 20,
  },
  list: {
    paddingBottom: 32,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardInfo: {
    flex: 1,
    marginRight: 12,
  },
  amountText: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.foreground,
  },
  hashText: {
    fontSize: 13,
    fontFamily: "monospace",
    color: Colors.gray,
    marginTop: 2,
  },
  leafText: {
    fontSize: 12,
    color: Colors.gray,
    marginTop: 2,
  },
  progressContainer: {
    marginBottom: 16,
  },
  progressBarBg: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.secondary,
    overflow: "hidden",
  },
  progressBarFill: {
    height: 6,
    borderRadius: 3,
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
  successTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.success,
    marginTop: 16,
  },
  successSubtitle: {
    fontSize: 14,
    color: Colors.gray,
    marginTop: 8,
    textAlign: "center",
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.error,
    marginTop: 16,
  },
  errorSubtitle: {
    fontSize: 14,
    color: Colors.gray,
    marginTop: 8,
    textAlign: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.grayLight,
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: Colors.gray,
    marginTop: 8,
    textAlign: "center",
  },
});
