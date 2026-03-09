import React from "react";
import { View, StyleSheet } from "react-native";
import { Card, AmountDisplay } from "@/components/ui";

interface BalanceCardProps {
  balanceSats: number;
}

export default function BalanceCard({ balanceSats }: BalanceCardProps) {
  return (
    <Card variant="privacy">
      <View style={styles.container}>
        <AmountDisplay
          sats={balanceSats}
          label="Shielded Balance"
          showSats={balanceSats > 0}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    paddingVertical: 8,
  },
});
