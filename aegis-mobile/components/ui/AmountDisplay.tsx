import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Colors } from "@/lib/colors";
import { formatSats, cn } from "@/lib/utils";

interface AmountDisplayProps {
  /** Amount in satoshis */
  sats: number;
  /** Optional label above the amount (e.g., "Shielded Balance") */
  label?: string;
  /** Show sats value below */
  showSats?: boolean;
  /** Additional className for container */
  className?: string;
}

export function AmountDisplay({
  sats,
  label,
  showSats = true,
  className,
}: AmountDisplayProps) {
  const btcString = formatSats(sats);

  return (
    <View className={cn("items-center", className)}>
      {label && (
        <Text style={styles.label}>{label}</Text>
      )}
      <Text style={styles.amount}>
        {btcString}
        <Text style={styles.unit}> BTC</Text>
      </Text>
      {showSats && (
        <Text style={styles.sats}>
          {sats.toLocaleString()} sats
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: Colors.gray,
    fontSize: 14,
    fontWeight: "500",
    marginBottom: 4,
  },
  amount: {
    color: Colors.privacy,
    fontSize: 36,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  unit: {
    fontSize: 18,
    fontWeight: "500",
    color: Colors.grayLight,
  },
  sats: {
    color: Colors.gray,
    fontSize: 14,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
});
