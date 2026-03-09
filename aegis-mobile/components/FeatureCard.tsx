import React from "react";
import { Pressable, View, Text, StyleSheet } from "react-native";
import { Colors } from "@/lib/colors";

type FeatureVariant = "btc" | "privacy" | "sol";

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  variant: FeatureVariant;
  onPress?: () => void;
}

const accentColors: Record<FeatureVariant, string> = {
  btc: Colors.btc,
  privacy: Colors.privacy,
  sol: Colors.sol,
};

const bgColors: Record<FeatureVariant, string> = {
  btc: "rgba(247, 147, 26, 0.10)",
  privacy: "rgba(20, 241, 149, 0.10)",
  sol: "rgba(153, 69, 255, 0.10)",
};

export function FeatureCard({
  icon,
  title,
  description,
  variant,
  onPress,
}: FeatureCardProps) {
  const accent = accentColors[variant];
  const bg = bgColors[variant];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={[styles.iconCircle, { backgroundColor: bg }]}>
        {icon}
      </View>
      <View style={styles.textCol}>
        <Text style={[styles.title, { color: accent }]}>{title}</Text>
        {description ? (
          <Text style={styles.description} numberOfLines={1}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: Colors.card,
    borderRadius: 14,
    padding: 14,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
  },
  description: {
    fontSize: 13,
    color: Colors.gray,
  },
});
