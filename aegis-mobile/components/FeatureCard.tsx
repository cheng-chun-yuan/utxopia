import React from "react";
import { Pressable, View, Text, StyleSheet } from "react-native";
import { Card } from "@/components/ui";
import { Colors } from "@/lib/colors";

type FeatureVariant = "btc" | "privacy" | "sol";

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  variant: FeatureVariant;
  onPress?: () => void;
}

/** Map feature variants to Card component variants */
const cardVariantMap: Record<FeatureVariant, "btc" | "privacy" | "purple"> = {
  btc: "btc",
  privacy: "privacy",
  sol: "purple",
};

const accentColors: Record<FeatureVariant, string> = {
  btc: Colors.btc,
  privacy: Colors.privacy,
  sol: Colors.sol,
};

export function FeatureCard({
  icon,
  title,
  description,
  variant,
  onPress,
}: FeatureCardProps) {
  const cardVariant = cardVariantMap[variant];
  const accent = accentColors[variant];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}
    >
      <Card variant={cardVariant} className="mb-3">
        <View style={styles.row}>
          <View
            style={[
              styles.iconContainer,
              { backgroundColor: `${accent}15` },
            ]}
          >
            {icon}
          </View>
          <View style={styles.textContainer}>
            <Text style={[styles.title, { color: accent }]}>{title}</Text>
            <Text style={styles.description}>{description}</Text>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  textContainer: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
  },
  description: {
    fontSize: 13,
    color: Colors.gray,
    lineHeight: 18,
  },
});
