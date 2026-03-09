import React from "react";
import { View, StyleSheet, Platform, type ViewProps } from "react-native";
import { Colors } from "@/lib/colors";
import { cn } from "@/lib/utils";

type CardVariant = "default" | "btc" | "privacy" | "purple";

interface CardProps extends Omit<ViewProps, "style"> {
  variant?: CardVariant;
  className?: string;
  children: React.ReactNode;
}

const variantBorderColors: Record<CardVariant, string> = {
  default: Colors.border,
  btc: "rgba(247, 147, 26, 0.3)",
  privacy: "rgba(20, 241, 149, 0.3)",
  purple: "rgba(255, 171, 254, 0.3)",
};

const variantBackgrounds: Record<CardVariant, string> = {
  default: Colors.card,
  btc: "rgba(247, 147, 26, 0.05)",
  privacy: "rgba(20, 241, 149, 0.05)",
  purple: "rgba(255, 171, 254, 0.05)",
};

export function Card({
  variant = "default",
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <View
      className={cn("rounded-2xl p-4", className)}
      style={[
        styles.base,
        {
          backgroundColor: variantBackgrounds[variant],
          borderColor: variantBorderColors[variant],
        },
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
      },
      android: {
        elevation: 4,
      },
    }),
  },
});
