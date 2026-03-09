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
import { Card } from "@/components/ui";
import { Colors } from "@/lib/colors";

interface ActionItem {
  label: string;
  icon: LucideIcon;
  color: string;
  route: string;
}

const actions: ActionItem[] = [
  {
    label: "Deposit",
    icon: ArrowDownLeft,
    color: Colors.btc,
    route: "/vault/deposit",
  },
  {
    label: "Send",
    icon: ArrowUpRight,
    color: Colors.privacy,
    route: "/vault/pay",
  },
  {
    label: "Received",
    icon: Inbox,
    color: Colors.purple,
    route: "/vault/received",
  },
  {
    label: "Activity",
    icon: Clock,
    color: Colors.grayLight,
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
          style={styles.cell}
          onPress={() => handlePress(action.route)}
        >
          <Card className="flex-1 items-center justify-center">
            <action.icon size={28} color={action.color} />
            <Text style={[styles.label, { color: action.color }]}>
              {action.label}
            </Text>
          </Card>
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
  },
  cell: {
    width: "47%",
    flexGrow: 1,
    aspectRatio: 1.3,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    marginTop: 8,
  },
});
