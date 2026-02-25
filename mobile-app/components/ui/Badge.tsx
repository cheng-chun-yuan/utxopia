/**
 * Badge Component
 *
 * Small status indicator with icon and text.
 */

import { memo } from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import { colors, spacing, radius, typography } from './theme';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export interface BadgeProps {
  icon?: string;
  text: string;
  variant?: BadgeVariant;
  style?: ViewStyle;
}

const variantStyles: Record<BadgeVariant, { bg: string; color: string }> = {
  success: { bg: colors.successLight, color: colors.success },
  warning: { bg: colors.bitcoinLight, color: colors.bitcoin },
  danger: { bg: colors.dangerLight, color: colors.danger },
  info: { bg: colors.primaryLight, color: colors.primary },
  muted: { bg: colors.dark.card, color: colors.dark.textMuted },
};

export const Badge = memo(function Badge({
  icon,
  text,
  variant = 'info',
  style,
}: BadgeProps) {
  const variantStyle = variantStyles[variant];

  return (
    <View style={[styles.badge, { backgroundColor: variantStyle.bg }, style]}>
      {icon ? (
        <FontAwesome name={icon as any} size={12} color={variantStyle.color} />
      ) : null}
      <Text style={[styles.text, { color: variantStyle.color }]}>{text}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  text: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
  },
});
