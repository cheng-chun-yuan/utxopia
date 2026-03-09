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
      {/* Title */}
      <View style={styles.header}>
        <Text style={styles.title}>Aegis</Text>
      </View>

      {/* Stats row */}
      <PoolStats />

      {/* Features */}
      <View style={styles.features}>
        <FeatureCard
          icon={<Shield size={20} color={Colors.btc} />}
          title="Private Deposits"
          variant="btc"
        />
        <FeatureCard
          icon={<ArrowLeftRight size={20} color={Colors.privacy} />}
          title="Shielded Transfers"
          variant="privacy"
        />
        <FeatureCard
          icon={<Unlock size={20} color={Colors.sol} />}
          title="Anonymous Withdrawals"
          variant="sol"
        />
      </View>

      <View style={styles.bottomPadding} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: 24,
    paddingBottom: 20,
  },
  title: {
    fontSize: 34,
    fontWeight: "800",
    color: Colors.foreground,
    letterSpacing: -0.5,
  },
  features: {
    marginTop: 24,
    gap: 10,
  },
  bottomPadding: {
    height: 32,
  },
});
