import React from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { Colors } from "@/lib/colors";
import { cn } from "@/lib/utils";

type SpinnerSize = "sm" | "md" | "lg";

interface SpinnerProps {
  size?: SpinnerSize;
  color?: string;
  label?: string;
  className?: string;
}

const sizeMap: Record<SpinnerSize, "small" | "large"> = {
  sm: "small",
  md: "small",
  lg: "large",
};

const sizeScale: Record<SpinnerSize, number> = {
  sm: 0.8,
  md: 1,
  lg: 1.4,
};

export function Spinner({
  size = "md",
  color = Colors.privacy,
  label,
  className,
}: SpinnerProps) {
  return (
    <View className={cn("items-center justify-center", className)}>
      <ActivityIndicator
        size={sizeMap[size]}
        color={color}
        style={{ transform: [{ scale: sizeScale[size] }] }}
      />
      {label && (
        <Text style={styles.label}>{label}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: Colors.gray,
    fontSize: 13,
    marginTop: 8,
  },
});
