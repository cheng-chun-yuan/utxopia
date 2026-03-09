import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Colors } from "@/lib/colors";
import { formatSats } from "@/lib/utils";

interface InboxItemProps {
  commitment: string;
  amount: number;
  timestamp: number;
  spent: boolean;
  onPress?: () => void;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function InboxItem({
  amount,
  timestamp,
  spent,
  onPress,
}: InboxItemProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.left}>
        <Text style={styles.amount}>{formatSats(amount)} BTC</Text>
        <Text style={styles.timestamp}>{formatTimestamp(timestamp)}</Text>
      </View>

      <View style={styles.right}>
        <View
          style={[styles.dot, spent ? styles.dotSpent : styles.dotAvailable]}
        />
        <Text
          style={[
            styles.status,
            spent ? styles.statusSpent : styles.statusAvailable,
          ]}
        >
          {spent ? "Spent" : "Available"}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  pressed: {
    opacity: 0.7,
  },
  left: {
    flex: 1,
    gap: 2,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  amount: {
    color: Colors.foreground,
    fontSize: 16,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  timestamp: {
    color: Colors.gray,
    fontSize: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotAvailable: {
    backgroundColor: Colors.privacy,
  },
  dotSpent: {
    backgroundColor: Colors.gray,
  },
  status: {
    fontSize: 12,
    fontWeight: "500",
  },
  statusAvailable: {
    color: Colors.privacy,
  },
  statusSpent: {
    color: Colors.gray,
  },
});
