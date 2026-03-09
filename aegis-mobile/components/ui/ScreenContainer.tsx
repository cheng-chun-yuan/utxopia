import React from "react";
import {
  View,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors } from "@/lib/colors";
import { cn } from "@/lib/utils";

interface ScreenContainerProps {
  children: React.ReactNode;
  /** Wrap children in a ScrollView */
  scrollable?: boolean;
  /** Additional className for the inner content view */
  className?: string;
  /** Disable SafeAreaView edges (e.g., when inside a tab navigator that already handles safe area) */
  edges?: ("top" | "bottom" | "left" | "right")[];
}

export function ScreenContainer({
  children,
  scrollable = false,
  className,
  edges = ["top", "bottom", "left", "right"],
}: ScreenContainerProps) {
  const content = scrollable ? (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View className={cn("flex-1 px-4", className)}>{children}</View>
    </ScrollView>
  ) : (
    <View className={cn("flex-1 px-4", className)}>{children}</View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={edges}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {content}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
});
