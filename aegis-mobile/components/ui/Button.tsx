import React, { useCallback } from "react";
import {
  Pressable,
  Text,
  ActivityIndicator,
  StyleSheet,
  Platform,
  type PressableProps,
  type ViewStyle,
  type TextStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Colors } from "@/lib/colors";
import { cn } from "@/lib/utils";

type ButtonVariant =
  | "primary"
  | "secondary"
  | "tertiary"
  | "ghost"
  | "danger"
  | "bitcoin";

type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  className?: string;
  textClassName?: string;
}

const variantStyles: Record<ButtonVariant, ViewStyle> = {
  primary: {
    backgroundColor: Colors.privacy,
  },
  secondary: {
    backgroundColor: Colors.muted,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tertiary: {
    backgroundColor: Colors.secondary,
  },
  ghost: {
    backgroundColor: "transparent",
  },
  danger: {
    backgroundColor: Colors.error,
  },
  bitcoin: {
    backgroundColor: Colors.btc,
  },
};

const variantTextStyles: Record<ButtonVariant, TextStyle> = {
  primary: { color: Colors.background, fontWeight: "700" },
  secondary: { color: Colors.foreground, fontWeight: "600" },
  tertiary: { color: Colors.foreground, fontWeight: "600" },
  ghost: { color: Colors.grayLight, fontWeight: "600" },
  danger: { color: "#ffffff", fontWeight: "700" },
  bitcoin: { color: Colors.background, fontWeight: "700" },
};

const sizeStyles: Record<ButtonSize, ViewStyle> = {
  sm: { paddingHorizontal: 16, minHeight: 44 },
  md: { paddingHorizontal: 20, minHeight: 48 },
  lg: { paddingHorizontal: 24, minHeight: 56 },
};

const sizeTextStyles: Record<ButtonSize, TextStyle> = {
  sm: { fontSize: 14 },
  md: { fontSize: 16 },
  lg: { fontSize: 18 },
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  textClassName,
  onPress,
  ...rest
}: ButtonProps) {
  const handlePress = useCallback(
    (e: Parameters<NonNullable<PressableProps["onPress"]>>[0]) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress?.(e);
    },
    [onPress],
  );

  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDisabled}
      className={cn("items-center justify-center flex-row", className)}
      style={({ pressed }) => [
        styles.base,
        variantStyles[variant],
        sizeStyles[size],
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variantTextStyles[variant].color as string}
        />
      ) : typeof children === "string" ? (
        <Text
          className={textClassName}
          style={[variantTextStyles[variant], sizeTextStyles[size]]}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: 12,
    gap: 8,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.98 }],
  },
  disabled: {
    opacity: 0.4,
  },
});
