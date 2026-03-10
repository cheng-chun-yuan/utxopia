import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Colors } from "@/lib/colors";
import { formatSats } from "@/lib/utils";
import { usePoolStats } from "@/hooks/use-pool-stats";

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillValue}>{value}</Text>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  );
}

function SkeletonPill() {
  return (
    <View style={styles.pill}>
      <View style={styles.skeletonValue} />
      <View style={styles.skeletonLabel} />
    </View>
  );
}

export function PoolStats() {
  const { stats, isLoading } = usePoolStats();

  if (isLoading || !stats) {
    return (
      <View style={styles.row}>
        <SkeletonPill />
        <SkeletonPill />
        <SkeletonPill />
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <StatPill
        value={`${formatSats(stats.totalShielded)}`}
        label="Shielded"
      />
      <StatPill
        value={stats.depositCount.toLocaleString()}
        label="Deposits"
      />
      <StatPill
        value={`${formatSats(stats.totalMinted)}`}
        label="Volume"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
  },
  pill: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 10,
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pillValue: {
    color: Colors.foreground,
    fontSize: 14,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  pillLabel: {
    color: Colors.gray,
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  skeletonValue: {
    width: 48,
    height: 16,
    borderRadius: 4,
    backgroundColor: Colors.secondary,
  },
  skeletonLabel: {
    width: 36,
    height: 10,
    borderRadius: 3,
    backgroundColor: Colors.secondary,
    marginTop: 2,
  },
});
