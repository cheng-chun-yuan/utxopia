/**
 * Separator Component
 *
 * Memoized separator for FlashList and other lists.
 * Following React Native best practices - ItemSeparatorComponent should be memoized.
 */

import { memo } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { spacing } from './theme';

export interface SeparatorProps {
  size?: keyof typeof spacing | number;
  horizontal?: boolean;
  style?: ViewStyle;
}

export const Separator = memo(function Separator({
  size = 'sm',
  horizontal = false,
  style,
}: SeparatorProps) {
  const sizeValue = typeof size === 'number' ? size : spacing[size];

  return (
    <View
      style={[
        horizontal ? { width: sizeValue } : { height: sizeValue },
        style,
      ]}
    />
  );
});

// Pre-built separators for common use cases (avoids creating inline components)
export const ListSeparator = memo(function ListSeparator() {
  return <View style={styles.listSeparator} />;
});

export const SectionSeparator = memo(function SectionSeparator() {
  return <View style={styles.sectionSeparator} />;
});

const styles = StyleSheet.create({
  listSeparator: {
    height: spacing.sm,
  },
  sectionSeparator: {
    height: spacing.lg,
  },
});
