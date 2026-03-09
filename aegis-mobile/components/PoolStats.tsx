import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Colors } from "@/lib/colors";
import { formatSats } from "@/lib/utils";
import { Spinner } from "@/components/ui";
import { usePoolStats } from "@/hooks/use-pool-stats";

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statItem}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function SkeletonItem() {
  return (
    <View style={styles.statItem}>
      <View style={styles.skeletonValue} />
      <View style={styles.skeletonLabel} />
    </View>
  );
}

export function PoolStats() {
  const { stats, isLoading } = usePoolStats();

  if (isLoading || !stats) {
    return (
      <View style={styles.container}>
        <SkeletonItem />
        <SkeletonItem />
        <SkeletonItem />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatItem
        label="Total Shielded"
        value={`${formatSats(stats.totalShielded)} BTC`}
      />
      <StatItem label="Deposits" value={stats.depositCount.toLocaleString()} />
      <StatItem
        label="Total Minted"
        value={`${formatSats(stats.totalMinted)} BTC`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 8,
  },
  statItem: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  statValue: {
    color: Colors.foreground,
    fontSize: 16,
    fontWeight: "700",
  },
  statLabel: {
    color: Colors.gray,
    fontSize: 12,
    fontWeight: "500",
  },
  skeletonValue: {
    width: 64,
    height: 18,
    borderRadius: 6,
    backgroundColor: Colors.secondary,
  },
  skeletonLabel: {
    width: 48,
    height: 12,
    borderRadius: 4,
    backgroundColor: Colors.secondary,
    marginTop: 4,
  },
});
