import React, { useState, useRef } from "react";
import {
  TextInput,
  View,
  Text,
  StyleSheet,
  Platform,
  type TextInputProps,
} from "react-native";
import { Colors } from "@/lib/colors";
import { cn } from "@/lib/utils";

interface InputProps extends Omit<TextInputProps, "style"> {
  label?: string;
  error?: string;
  className?: string;
  containerClassName?: string;
}

export function Input({
  label,
  error,
  className,
  containerClassName,
  onFocus,
  onBlur,
  ...rest
}: InputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);

  return (
    <View className={cn("w-full", containerClassName)}>
      {label && (
        <Text style={styles.label}>{label}</Text>
      )}
      <TextInput
        ref={inputRef}
        placeholderTextColor={Colors.gray}
        selectionColor={Colors.privacy}
        className={className}
        style={[
          styles.input,
          isFocused && styles.inputFocused,
          error ? styles.inputError : undefined,
        ]}
        onFocus={(e) => {
          setIsFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          onBlur?.(e);
        }}
        {...rest}
      />
      {error && (
        <Text style={styles.error}>{error}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: Colors.grayLight,
    fontSize: 14,
    fontWeight: "500",
    marginBottom: 8,
  },
  input: {
    backgroundColor: Colors.muted,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.foreground,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: Platform.select({ ios: 14, android: 10 }),
  },
  inputFocused: {
    borderColor: Colors.privacy,
  },
  inputError: {
    borderColor: Colors.error,
  },
  error: {
    color: Colors.error,
    fontSize: 12,
    marginTop: 4,
  },
});
