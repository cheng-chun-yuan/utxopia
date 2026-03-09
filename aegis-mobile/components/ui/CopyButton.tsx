import React, { useState, useCallback } from "react";
import {
  Pressable,
  Text,
  StyleSheet,
  type PressableProps,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Copy, Check } from "lucide-react-native";
import { Colors } from "@/lib/colors";
import { cn } from "@/lib/utils";

interface CopyButtonProps extends Omit<PressableProps, "children" | "style"> {
  text: string;
  label?: string;
  iconSize?: number;
  className?: string;
}

export function CopyButton({
  text,
  label,
  iconSize = 18,
  className,
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handlePress = useCallback(async () => {
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <Pressable
      onPress={handlePress}
      className={cn("flex-row items-center gap-2", className)}
      style={({ pressed }) => [
        styles.base,
        pressed && styles.pressed,
      ]}
      hitSlop={8}
      {...rest}
    >
      {copied ? (
        <Check size={iconSize} color={Colors.success} />
      ) : (
        <Copy size={iconSize} color={Colors.grayLight} />
      )}
      {label !== undefined && (
        <Text style={[styles.label, copied && styles.labelCopied]}>
          {copied ? "Copied!" : label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  pressed: {
    opacity: 0.7,
  },
  label: {
    color: Colors.grayLight,
    fontSize: 14,
    fontWeight: "500",
  },
  labelCopied: {
    color: Colors.success,
  },
});
