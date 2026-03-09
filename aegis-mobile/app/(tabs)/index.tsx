import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Shield, ArrowLeftRight, Unlock } from "lucide-react-native";
import { ScreenContainer } from "@/components/ui";
import { PoolStats } from "@/components/PoolStats";
import { FeatureCard } from "@/components/FeatureCard";
import { Colors } from "@/lib/colors";

export default function HomeScreen() {
  return (
    <ScreenContainer scrollable edges={["left", "right", "bottom"]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Aegis</Text>
        <Text style={styles.subtitle}>Private Bitcoin Bridge</Text>
      </View>

      {/* Pool Stats */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Pool Overview</Text>
        <PoolStats />
      </View>

      {/* Feature Cards */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Features</Text>

        <FeatureCard
          icon={<Shield size={22} color={Colors.btc} />}
          title="Private Deposits"
          description="Deposit BTC from any wallet via QR code"
          variant="btc"
        />

        <FeatureCard
          icon={<ArrowLeftRight size={22} color={Colors.privacy} />}
          title="Shielded Transfers"
          description="Send zkBTC with zero-knowledge proofs"
          variant="privacy"
        />

        <FeatureCard
          icon={<Unlock size={22} color={Colors.sol} />}
          title="Anonymous Withdrawals"
          description="Withdraw BTC without revealing your identity"
          variant="sol"
        />
      </View>

      {/* Bottom padding for tab bar */}
      <View style={styles.bottomPadding} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: 24,
    paddingBottom: 8,
    gap: 4,
  },
  title: {
    fontSize: 34,
    fontWeight: "800",
    color: Colors.privacy,
  },
  subtitle: {
    fontSize: 16,
    color: Colors.gray,
    fontWeight: "500",
  },
  section: {
    marginTop: 24,
    gap: 12,
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.grayLight,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  bottomPadding: {
    height: 32,
  },
});
