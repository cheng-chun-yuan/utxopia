import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Colors } from "@/lib/colors";
import { formatSats } from "@/lib/utils";

interface BalanceCardProps {
  balanceSats: number;
}

export default function BalanceCard({ balanceSats }: BalanceCardProps) {
  const btcString = formatSats(balanceSats);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Shielded Balance</Text>
      <Text style={styles.amount}>
        <Text style={styles.symbol}>&#8383; </Text>
        {btcString}
      </Text>
      {balanceSats > 0 && (
        <Text style={styles.sats}>{balanceSats.toLocaleString()} sats</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 32,
    paddingBottom: 24,
    alignItems: "center",
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.gray,
    marginBottom: 8,
  },
  amount: {
    fontSize: 42,
    fontWeight: "700",
    color: Colors.foreground,
    fontVariant: ["tabular-nums"],
    letterSpacing: -1,
  },
  symbol: {
    fontSize: 36,
    color: Colors.btc,
  },
  sats: {
    fontSize: 14,
    color: Colors.gray,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
});
