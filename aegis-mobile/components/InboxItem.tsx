import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { Card } from "@/components/ui";
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
    <Pressable onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      <Card className="mb-3">
        <View style={styles.row}>
          <View style={styles.left}>
            <Text style={styles.amount}>{formatSats(amount)} BTC</Text>
            <Text style={styles.sats}>
              {amount.toLocaleString()} sats
            </Text>
            <Text style={styles.timestamp}>{formatTimestamp(timestamp)}</Text>
          </View>

          <View style={styles.right}>
            <View
              style={[
                styles.badge,
                spent ? styles.badgeSpent : styles.badgeAvailable,
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  spent ? styles.badgeTextSpent : styles.badgeTextAvailable,
                ]}
              >
                {spent ? "Spent" : "Available"}
              </Text>
            </View>

            {onPress && (
              <ChevronRight size={18} color={Colors.gray} style={styles.chevron} />
            )}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.7,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  left: {
    flex: 1,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  amount: {
    color: Colors.foreground,
    fontSize: 17,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  sats: {
    color: Colors.gray,
    fontSize: 13,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  timestamp: {
    color: Colors.gray,
    fontSize: 12,
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeAvailable: {
    backgroundColor: "rgba(20, 241, 149, 0.12)",
  },
  badgeSpent: {
    backgroundColor: "rgba(139, 138, 158, 0.12)",
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  badgeTextAvailable: {
    color: Colors.privacy,
  },
  badgeTextSpent: {
    color: Colors.gray,
  },
  chevron: {
    marginLeft: 4,
  },
});
