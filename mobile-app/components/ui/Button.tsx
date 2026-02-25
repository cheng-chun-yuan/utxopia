/**
 * Button Component
 *
 * Reusable button with variants following React Native best practices.
 * Uses Pressable instead of TouchableOpacity for better feedback.
 */

import { memo } from 'react';
import {
  Pressable,
  Text,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  TextStyle,
  PressableProps,
} from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import { colors, spacing, radius, typography } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'bitcoin' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'style'> {
  title: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

const variantStyles: Record<ButtonVariant, { bg: string; text: string }> = {
  primary: { bg: colors.primary, text: '#fff' },
  secondary: { bg: colors.dark.card, text: colors.dark.text },
  bitcoin: { bg: colors.bitcoin, text: '#fff' },
  danger: { bg: colors.danger, text: '#fff' },
  ghost: { bg: 'transparent', text: colors.primary },
};

const sizeStyles: Record<ButtonSize, { paddingH: number; paddingV: number; fontSize: number }> = {
  sm: { paddingH: spacing.lg, paddingV: spacing.sm, fontSize: typography.sm },
  md: { paddingH: spacing.xl, paddingV: spacing.md, fontSize: typography.lg },
  lg: { paddingH: spacing['2xl'], paddingV: spacing.lg, fontSize: typography.xl },
};

export const Button = memo(function Button({
  title,
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'left',
  loading = false,
  disabled,
  style,
  textStyle,
  ...props
}: ButtonProps) {
  const variantStyle = variantStyles[variant];
  const sizeStyle = sizeStyles[size];

  const isDisabled = disabled || loading;

  const content = loading ? (
    <ActivityIndicator color={variantStyle.text} size="small" />
  ) : (
    <>
      {icon && iconPosition === 'left' ? (
        <FontAwesome
          name={icon as any}
          size={sizeStyle.fontSize}
          color={variantStyle.text}
        />
      ) : null}
      <Text
        style={[
          styles.text,
          { color: variantStyle.text, fontSize: sizeStyle.fontSize },
          textStyle,
        ]}
      >
        {title}
      </Text>
      {icon && iconPosition === 'right' ? (
        <FontAwesome
          name={icon as any}
          size={sizeStyle.fontSize}
          color={variantStyle.text}
        />
      ) : null}
    </>
  );

  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: variantStyle.bg,
          paddingHorizontal: sizeStyle.paddingH,
          paddingVertical: sizeStyle.paddingV,
          opacity: isDisabled ? 0.5 : pressed ? 0.8 : 1,
        },
        variant === 'ghost' && styles.ghostBorder,
        style,
      ]}
      disabled={isDisabled}
      {...props}
    >
      {content}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    gap: spacing.sm,
  },
  text: {
    fontWeight: typography.semibold,
  },
  ghostBorder: {
    borderWidth: 1,
    borderColor: colors.primary,
  },
});
