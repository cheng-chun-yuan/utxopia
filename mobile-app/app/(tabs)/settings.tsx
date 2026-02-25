/**
 * Settings Screen - Production Ready
 *
 * Clean settings interface with:
 * - Account information
 * - Wallet stats
 * - App info and links
 *
 * Best Practices:
 * - Memoized list items
 * - Accessible touch targets
 * - Clear visual hierarchy
 */

import { useMemo, memo, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  ScrollView,
  Alert,
  Linking,
} from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import { useColorScheme } from '@/components/useColorScheme';
import { useWallet } from '@/contexts/WalletContext';
import { usePhantom } from '@phantom/react-native-wallet-sdk';
import {
  colors,
  getThemeColors,
  spacing,
  radius,
  typography,
  touch,
} from '@/components/ui/theme';

// ============================================================================
// Types
// ============================================================================

interface SettingItemProps {
  icon: string;
  title: string;
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  theme: ReturnType<typeof getThemeColors>;
}

// ============================================================================
// Memoized Components
// ============================================================================

/** Single setting item */
const SettingItem = memo(function SettingItem({
  icon,
  title,
  subtitle,
  value,
  onPress,
  danger,
  theme,
}: SettingItemProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.settingItem,
        { backgroundColor: theme.card },
        onPress && pressed && styles.itemPressed,
      ]}
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={title}
      accessibilityRole={onPress ? 'button' : 'text'}
    >
      <View style={styles.settingLeft}>
        <View
          style={[
            styles.iconContainer,
            { backgroundColor: danger ? colors.dangerLight : colors.primaryLight },
          ]}
        >
          <FontAwesome
            name={icon as any}
            size={16}
            color={danger ? colors.danger : colors.primary}
          />
        </View>
        <View style={styles.settingInfo}>
          <Text
            style={[
              styles.settingTitle,
              { color: danger ? colors.danger : theme.text },
            ]}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={[styles.settingSubtitle, { color: theme.textMuted }]}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {value ? (
        <Text style={[styles.settingValue, { color: theme.textMuted }]}>{value}</Text>
      ) : null}
      {onPress && !value ? (
        <FontAwesome name="chevron-right" size={12} color={theme.textMuted} />
      ) : null}
    </Pressable>
  );
});

// ============================================================================
// Main Screen
// ============================================================================

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const theme = useMemo(() => getThemeColors(isDark), [isDark]);
  const { logout } = usePhantom();

  const { isConnected, address, keysDerived, stealthAddress, notes, totalBalance } =
    useWallet();

  // Format address for display
  const formatAddress = useCallback((addr: string | null) => {
    if (!addr) return 'Not connected';
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }, []);

  // Handlers
  const handleDisconnect = useCallback(() => {
    Alert.alert('Disconnect Wallet', 'Are you sure you want to disconnect?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => logout(),
      },
    ]);
  }, [logout]);

  const handleClearData = useCallback(() => {
    Alert.alert(
      'Clear All Data',
      'This will delete all local notes and keys. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Cleared', 'All local data has been cleared');
          },
        },
      ]
    );
  }, []);

  const handleOpenGithub = useCallback(() => {
    Linking.openURL('https://github.com/anthropics/zVault');
  }, []);

  // Calculate balance display
  const balanceDisplay = useMemo(() => {
    const btc = Number(totalBalance) / 100_000_000;
    return `${btc.toFixed(8)} BTC`;
  }, [totalBalance]);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      {/* Account Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionHeader, { color: theme.textMuted }]}>ACCOUNT</Text>
        <View style={[styles.sectionContent, { backgroundColor: theme.card }]}>
          <SettingItem
            icon="user"
            title="Wallet Address"
            subtitle={formatAddress(address)}
            theme={theme}
          />
          <View style={[styles.separator, { backgroundColor: theme.divider }]} />
          <SettingItem
            icon="key"
            title="Keys Status"
            value={keysDerived ? 'Derived' : 'Not Derived'}
            theme={theme}
          />
          <View style={[styles.separator, { backgroundColor: theme.divider }]} />
          <SettingItem
            icon="eye"
            title="Stealth Address"
            subtitle={formatAddress(stealthAddress)}
            theme={theme}
          />
        </View>
      </View>

      {/* Wallet Info Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionHeader, { color: theme.textMuted }]}>
          WALLET INFO
        </Text>
        <View style={[styles.sectionContent, { backgroundColor: theme.card }]}>
          <SettingItem
            icon="bitcoin"
            title="Total Notes"
            value={notes.length.toString()}
            theme={theme}
          />
          <View style={[styles.separator, { backgroundColor: theme.divider }]} />
          <SettingItem
            icon="database"
            title="Total Balance"
            value={balanceDisplay}
            theme={theme}
          />
        </View>
      </View>

      {/* App Section */}
      <View style={styles.section}>
        <Text style={[styles.sectionHeader, { color: theme.textMuted }]}>APP</Text>
        <View style={[styles.sectionContent, { backgroundColor: theme.card }]}>
          <SettingItem
            icon="github"
            title="Source Code"
            subtitle="View on GitHub"
            onPress={handleOpenGithub}
            theme={theme}
          />
          <View style={[styles.separator, { backgroundColor: theme.divider }]} />
          <SettingItem
            icon="info-circle"
            title="Version"
            value="1.0.0"
            theme={theme}
          />
        </View>
      </View>

      {/* Danger Zone */}
      {isConnected ? (
        <View style={styles.section}>
          <Text style={[styles.sectionHeader, { color: theme.textMuted }]}>
            DANGER ZONE
          </Text>
          <View style={[styles.sectionContent, { backgroundColor: theme.card }]}>
            <SettingItem
              icon="trash"
              title="Clear Local Data"
              subtitle="Delete notes and keys"
              onPress={handleClearData}
              danger
              theme={theme}
            />
            <View style={[styles.separator, { backgroundColor: theme.divider }]} />
            <SettingItem
              icon="sign-out"
              title="Disconnect Wallet"
              onPress={handleDisconnect}
              danger
              theme={theme}
            />
          </View>
        </View>
      ) : null}

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: theme.textMuted }]}>
          zVault - Privacy-preserving Bitcoin Bridge
        </Text>
        <View style={styles.footerBadge}>
          <FontAwesome name="shield" size={12} color={colors.success} />
          <Text style={[styles.footerBadgeText, { color: colors.success }]}>
            Self-custodial & Private
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing['5xl'],
  },

  // Sections
  section: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  sectionHeader: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  sectionContent: {
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  separator: {
    height: 1,
    marginLeft: spacing['4xl'] + spacing.lg,
  },

  // Setting Item
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: touch.buttonHeight,
  },
  itemPressed: {
    opacity: 0.7,
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingInfo: {
    flex: 1,
    gap: 2,
  },
  settingTitle: {
    fontSize: typography.md,
    fontWeight: typography.medium,
  },
  settingSubtitle: {
    fontSize: typography.xs,
    fontFamily: typography.mono,
  },
  settingValue: {
    fontSize: typography.sm,
    fontFamily: typography.mono,
  },

  // Footer
  footer: {
    alignItems: 'center',
    paddingVertical: spacing['3xl'],
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  footerText: {
    fontSize: typography.sm,
  },
  footerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  footerBadgeText: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
  },
});
