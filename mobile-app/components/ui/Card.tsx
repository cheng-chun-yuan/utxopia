/**
 * Card Component
 *
 * Reusable card container with consistent styling.
 * Uses borderCurve: 'continuous' for smoother corners.
 */

import { memo } from 'react';
import { View, StyleSheet, ViewStyle, ViewProps } from 'react-native';
import { spacing, radius } from './theme';

export interface CardProps extends ViewProps {
  padding?: keyof typeof spacing | number;
  variant?: 'default' | 'elevated';
  style?: ViewStyle;
  children: React.ReactNode;
}

export const Card = memo(function Card({
  padding = 'lg',
  variant = 'default',
  style,
  children,
  ...props
}: CardProps) {
  const paddingValue = typeof padding === 'number' ? padding : spacing[padding];

  return (
    <View
      style={[
        styles.card,
        { padding: paddingValue },
        variant === 'elevated' && styles.elevated,
        style,
      ]}
      {...props}
    >
      {children}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  elevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
});
