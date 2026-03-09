import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Inbox,
  Clock,
  type LucideIcon,
} from "lucide-react-native";
import { Colors } from "@/lib/colors";

interface ActionItem {
  label: string;
  icon: LucideIcon;
  color: string;
  bg: string;
  route: string;
}

const actions: ActionItem[] = [
  {
    label: "Deposit",
    icon: ArrowDownLeft,
    color: Colors.btc,
    bg: "rgba(247, 147, 26, 0.12)",
    route: "/vault/deposit",
  },
  {
    label: "Send",
    icon: ArrowUpRight,
    color: Colors.privacy,
    bg: "rgba(20, 241, 149, 0.12)",
    route: "/vault/pay",
  },
  {
    label: "Received",
    icon: Inbox,
    color: Colors.purple,
    bg: "rgba(255, 171, 254, 0.12)",
    route: "/vault/received",
  },
  {
    label: "Activity",
    icon: Clock,
    color: Colors.grayLight,
    bg: "rgba(139, 138, 158, 0.12)",
    route: "/vault/activity",
  },
];

export default function QuickActions() {
  const router = useRouter();

  const handlePress = (route: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(route as never);
  };

  return (
    <View style={styles.grid}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          style={({ pressed }) => [
            styles.cell,
            { opacity: pressed ? 0.8 : 1 },
          ]}
          onPress={() => handlePress(action.route)}
        >
          <View style={[styles.iconCircle, { backgroundColor: action.bg }]}>
            <action.icon size={22} color={action.color} />
          </View>
          <Text style={styles.label}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    paddingHorizontal: 4,
  },
  cell: {
    width: "47%",
    flexGrow: 1,
    backgroundColor: Colors.card,
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 16,
    gap: 12,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.foreground,
  },
});
