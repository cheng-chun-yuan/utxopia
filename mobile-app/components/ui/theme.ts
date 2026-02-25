/**
 * Theme Constants - Production Design System
 *
 * zVault Wallet Theme
 * Style: Dark glassmorphism with crypto/fintech aesthetics
 * Based on UI/UX Pro Max recommendations
 */

// ============================================================================
// Brand Colors
// ============================================================================

export const colors = {
  // Primary brand (Purple - Solana inspired)
  primary: '#9945FF',
  primaryLight: 'rgba(153, 69, 255, 0.15)',
  primaryMuted: 'rgba(153, 69, 255, 0.25)',
  primaryDark: '#7C3AED',

  // Secondary (Bitcoin orange)
  bitcoin: '#F59E0B',
  bitcoinLight: 'rgba(245, 158, 11, 0.1)',
  bitcoinMuted: 'rgba(245, 158, 11, 0.2)',

  // Success (Green - confirmed/available)
  success: '#14F195',
  successLight: 'rgba(20, 241, 149, 0.1)',
  successMuted: 'rgba(20, 241, 149, 0.2)',

  // Danger / Error
  danger: '#EF4444',
  dangerLight: 'rgba(239, 68, 68, 0.1)',
  dangerMuted: 'rgba(239, 68, 68, 0.2)',

  // Warning
  warning: '#FBBF24',
  warningLight: 'rgba(251, 191, 36, 0.1)',

  // Neutral (Dark Mode)
  dark: {
    background: '#0A0A0B',
    surface: '#111113',
    card: '#18181B',
    cardElevated: '#1F1F23',
    input: '#27272A',
    text: '#FAFAFA',
    textSecondary: '#A1A1AA',
    textMuted: '#71717A',
    border: '#27272A',
    borderLight: '#3F3F46',
    divider: 'rgba(255, 255, 255, 0.06)',
  },

  // Neutral (Light Mode)
  light: {
    background: '#FAFAFA',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    cardElevated: '#FFFFFF',
    input: '#F4F4F5',
    text: '#18181B',
    textSecondary: '#52525B',
    textMuted: '#71717A',
    border: '#E4E4E7',
    borderLight: '#D4D4D8',
    divider: 'rgba(0, 0, 0, 0.06)',
  },

  // Glass effect colors
  glass: {
    background: 'rgba(24, 24, 27, 0.8)',
    border: 'rgba(255, 255, 255, 0.1)',
    borderLight: 'rgba(255, 255, 255, 0.15)',
  },
} as const;

// ============================================================================
// Spacing (8pt grid)
// ============================================================================

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
  '6xl': 64,
} as const;

// ============================================================================
// Border Radius
// ============================================================================

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  full: 9999,
} as const;

// ============================================================================
// Typography
// ============================================================================

export const typography = {
  // Font families
  mono: 'SpaceMono',
  default: undefined, // System font (SF Pro on iOS, Roboto on Android)

  // Font sizes
  xs: 11,
  sm: 13,
  base: 15,
  md: 16,
  lg: 17,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,

  // Font weights (as const for TypeScript)
  weightNormal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,

  // Line heights
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.625,
} as const;

// ============================================================================
// Shadows
// ============================================================================

export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  glow: (color: string) => ({
    shadowColor: color,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 0,
  }),
} as const;

// ============================================================================
// Animation Durations
// ============================================================================

export const animation = {
  fast: 150,
  normal: 200,
  slow: 300,
} as const;

// ============================================================================
// Touch Targets (minimum 44px for accessibility)
// ============================================================================

export const touch = {
  minSize: 44,
  buttonHeight: 52,
  buttonHeightSm: 44,
  iconButton: 44,
  inputHeight: 52,
} as const;

// ============================================================================
// Theme Helper
// ============================================================================

/**
 * Get theme colors based on color scheme
 */
export function getThemeColors(isDark: boolean) {
  const scheme = isDark ? colors.dark : colors.light;
  return {
    ...scheme,
    primary: colors.primary,
    primaryLight: colors.primaryLight,
    primaryMuted: colors.primaryMuted,
    primaryDark: colors.primaryDark,
    success: colors.success,
    successLight: colors.successLight,
    successMuted: colors.successMuted,
    bitcoin: colors.bitcoin,
    bitcoinLight: colors.bitcoinLight,
    bitcoinMuted: colors.bitcoinMuted,
    danger: colors.danger,
    dangerLight: colors.dangerLight,
    dangerMuted: colors.dangerMuted,
    warning: colors.warning,
    warningLight: colors.warningLight,
    glass: colors.glass,
    isDark,
  };
}

export type ThemeColors = ReturnType<typeof getThemeColors>;
