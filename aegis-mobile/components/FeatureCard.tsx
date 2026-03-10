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
  privacy: Colors.accent,
  sol: Colors.sol,
};

export function FeatureCard({
  icon,
  title,
  description,
  variant,
  onPress,
}: FeatureCardProps) {
  const accent = accentColors[variant];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={styles.iconWrap}>{icon}</View>
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
    borderWidth: 1,
    borderColor: Colors.border,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.secondary,
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
