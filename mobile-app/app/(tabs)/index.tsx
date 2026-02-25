/**
 * Wallet Home Screen - Production Ready
 *
 * Simplified wallet interface with:
 * - Clean balance display
 * - Quick action buttons
 * - Recent activity list
 *
 * Best Practices:
 * - Memoized list items with primitive props
 * - Minimum 44px touch targets
 * - borderCurve: 'continuous' for iOS-native corners
 * - Proper accessibility labels
 */

import { useCallback, memo, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  RefreshControl,
  SafeAreaView,
} from 'react-native';
import { FlashList, ListRenderItemInfo } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { FontAwesome } from '@expo/vector-icons';
import { useColorScheme } from '@/components/useColorScheme';
import { useWallet, WalletNote } from '@/contexts/WalletContext';
import { usePhantom } from '@phantom/react-native-wallet-sdk';
import { formatBtc as sdkFormatBtc } from '@zvault/sdk';
import { ListSeparator } from '@/components/ui';
import {
  colors,
  getThemeColors,
  spacing,
  radius,
  typography,
  touch,
} from '@/components/ui/theme';

// ============================================================================
// Utilities
// ============================================================================

/** Format satoshis to BTC display */
function formatBalance(sats: bigint): string {
  const btc = Number(sats) / 100_000_000;
  if (btc === 0) return '0.00';
  if (btc >= 1) return btc.toFixed(4);
  if (btc >= 0.001) return btc.toFixed(6);
  return btc.toFixed(8);
}

/** Format USD value */
function formatUsd(sats: bigint, btcPrice: number = 95000): string {
  const btc = Number(sats) / 100_000_000;
  return btc * btcPrice < 1
    ? (btc * btcPrice).toFixed(2)
    : (btc * btcPrice).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

// ============================================================================
// Memoized Components
// ============================================================================

interface ActionButtonProps {
  icon: string;
  label: string;
  onPress: () => void;
  primary?: boolean;
}

/** Quick action button (Receive/Send) */
const ActionButton = memo(function ActionButton({
  icon,
  label,
  onPress,
  primary,
}: ActionButtonProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionButton,
        primary && styles.actionButtonPrimary,
        pressed && styles.actionButtonPressed,
      ]}
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <FontAwesome
        name={icon as any}
        size={20}
        color={primary ? '#fff' : colors.primary}
      />
      <Text
        style={[styles.actionButtonText, primary && styles.actionButtonTextPrimary]}
      >
        {label}
      </Text>
    </Pressable>
  );
});

interface NoteItemProps {
  amount: bigint;
  status: 'available' | 'pending' | 'spent';
  createdAt: number;
  textColor: string;
  mutedColor: string;
  cardBg: string;
}

/** Memoized note item for FlashList */
const NoteItem = memo(function NoteItem({
  amount,
  status,
  createdAt,
  textColor,
  mutedColor,
  cardBg,
}: NoteItemProps) {
  const isAvailable = status === 'available';
  const isPending = status === 'pending';

  return (
    <View style={[styles.noteItem, { backgroundColor: cardBg }]}>
      <View style={styles.noteLeft}>
        <View
          style={[
            styles.noteIcon,
            {
              backgroundColor: isAvailable
                ? colors.successLight
                : isPending
                ? colors.warningLight
                : colors.dark.divider,
            },
          ]}
        >
          <FontAwesome
            name={isAvailable ? 'check' : isPending ? 'clock-o' : 'times'}
            size={14}
            color={
              isAvailable
                ? colors.success
                : isPending
                ? colors.warning
                : mutedColor
            }
          />
        </View>
        <View style={styles.noteInfo}>
          <Text style={[styles.noteAmount, { color: textColor }]}>
            {formatBalance(amount)} BTC
          </Text>
          <Text style={[styles.noteStatus, { color: mutedColor }]}>
            {isAvailable ? 'Available' : isPending ? 'Confirming' : 'Spent'}
          </Text>
        </View>
      </View>
      <Text style={[styles.noteDate, { color: mutedColor }]}>
        {new Date(createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })}
      </Text>
    </View>
  );
});

// ============================================================================
// Main Screen
// ============================================================================

export default function WalletScreen() {
  const { push } = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { showLoginOptions } = usePhantom();

  const {
    isConnected,
    keysDerived,
    deriveKeys,
    isDerivingKeys,
    totalBalance,
    notes,
    refreshNotes,
    addDemoNote,
    isLoading,
  } = useWallet();

  const theme = useMemo(() => getThemeColors(isDark), [isDark]);

  // Stable callbacks
  const handleReceive = useCallback(() => push('/receive'), [push]);
  const handleSend = useCallback(() => push('/send'), [push]);

  // Render list item
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<WalletNote>) => (
      <NoteItem
        amount={item.amount}
        status={item.status}
        createdAt={item.createdAt}
        textColor={theme.text}
        mutedColor={theme.textMuted}
        cardBg={theme.card}
      />
    ),
    [theme]
  );

  const keyExtractor = useCallback((item: WalletNote) => item.id, []);

  // ========== NOT CONNECTED ==========
  if (!isConnected) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.centerContent}>
          {/* Logo */}
          <View style={styles.logoContainer}>
            <FontAwesome name="shield" size={48} color={colors.primary} />
          </View>

          {/* Title */}
          <Text style={[styles.heroTitle, { color: theme.text }]}>zVault</Text>
          <Text style={[styles.heroSubtitle, { color: theme.textSecondary }]}>
            Private Bitcoin Wallet
          </Text>

          {/* Connect Button */}
          <Pressable
            style={({ pressed }) => [
              styles.connectButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={showLoginOptions}
            accessibilityLabel="Connect Phantom Wallet"
            accessibilityRole="button"
          >
            <FontAwesome name="bolt" size={18} color="#fff" />
            <Text style={styles.connectButtonText}>Connect Wallet</Text>
          </Pressable>

          {/* Security badge */}
          <View style={styles.securityBadge}>
            <FontAwesome name="lock" size={12} color={colors.success} />
            <Text style={[styles.securityText, { color: theme.textMuted }]}>
              Self-custodial & Private
            </Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ========== KEYS NOT DERIVED ==========
  if (!keysDerived) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.centerContent}>
          <View style={[styles.logoContainer, { backgroundColor: colors.primaryLight }]}>
            <FontAwesome name="key" size={32} color={colors.primary} />
          </View>

          <Text style={[styles.heroTitle, { color: theme.text }]}>Setup Keys</Text>
          <Text
            style={[
              styles.heroSubtitle,
              { color: theme.textSecondary, textAlign: 'center', paddingHorizontal: spacing['3xl'] },
            ]}
          >
            Sign a message to derive your private viewing and spending keys
          </Text>

          <Pressable
            style={({ pressed }) => [
              styles.connectButton,
              pressed && styles.buttonPressed,
              isDerivingKeys && styles.buttonDisabled,
            ]}
            onPress={deriveKeys}
            disabled={isDerivingKeys}
            accessibilityLabel="Derive Keys"
            accessibilityRole="button"
          >
            {isDerivingKeys ? (
              <Text style={styles.connectButtonText}>Signing...</Text>
            ) : (
              <>
                <FontAwesome name="pencil" size={18} color="#fff" />
                <Text style={styles.connectButtonText}>Derive Keys</Text>
              </>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ========== MAIN WALLET VIEW ==========
  const ListHeader = (
    <View style={styles.header}>
      {/* Balance Card */}
      <View style={[styles.balanceCard, { backgroundColor: theme.card }]}>
        <Text style={[styles.balanceLabel, { color: theme.textMuted }]}>
          Total Balance
        </Text>
        <Text style={[styles.balanceAmount, { color: theme.text }]}>
          {formatBalance(totalBalance)}
          <Text style={styles.balanceCurrency}> BTC</Text>
        </Text>
        <Text style={[styles.balanceUsd, { color: theme.textSecondary }]}>
          ≈ ${formatUsd(totalBalance)} USD
        </Text>

        {/* Action Buttons */}
        <View style={styles.actionButtons}>
          <ActionButton icon="arrow-down" label="Receive" onPress={handleReceive} />
          <ActionButton icon="arrow-up" label="Send" onPress={handleSend} primary />
        </View>
      </View>

      {/* Activity Header */}
      {notes.length > 0 ? (
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Activity</Text>
          <Pressable onPress={() => addDemoNote(100000)}>
            <Text style={[styles.sectionAction, { color: colors.primary }]}>
              + Demo
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const ListEmpty = (
    <View style={[styles.emptyState, { backgroundColor: theme.card }]}>
      <FontAwesome name="inbox" size={40} color={theme.textMuted} />
      <Text style={[styles.emptyTitle, { color: theme.text }]}>No Activity Yet</Text>
      <Text style={[styles.emptySubtitle, { color: theme.textMuted }]}>
        Receive BTC to get started
      </Text>
      <Pressable
        style={({ pressed }) => [styles.emptyButton, pressed && styles.buttonPressed]}
        onPress={handleReceive}
      >
        <Text style={styles.emptyButtonText}>Receive BTC</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <FlashList
        data={notes}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmpty}
        ItemSeparatorComponent={ListSeparator}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={refreshNotes}
            tintColor={colors.primary}
          />
        }
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing['4xl'],
  },

  // Center content (connect/setup screens)
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['2xl'],
    gap: spacing.lg,
  },
  logoContainer: {
    width: 96,
    height: 96,
    borderRadius: radius['2xl'],
    borderCurve: 'continuous',
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  heroTitle: {
    fontSize: typography['3xl'],
    fontWeight: typography.bold,
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: typography.lg,
    lineHeight: typography.lg * typography.relaxed,
  },
  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['3xl'],
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    gap: spacing.sm,
    marginTop: spacing.xl,
    minWidth: 200,
    minHeight: touch.buttonHeight,
  },
  connectButtonText: {
    color: '#fff',
    fontSize: typography.lg,
    fontWeight: typography.semibold,
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  securityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing['2xl'],
  },
  securityText: {
    fontSize: typography.sm,
  },

  // Header
  header: {
    paddingTop: spacing.lg,
  },

  // Balance Card
  balanceCard: {
    padding: spacing['2xl'],
    borderRadius: radius.xl,
    borderCurve: 'continuous',
  },
  balanceLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  balanceAmount: {
    fontSize: typography['5xl'],
    fontWeight: typography.bold,
    fontFamily: typography.mono,
    marginTop: spacing.xs,
    letterSpacing: -1,
  },
  balanceCurrency: {
    fontSize: typography['2xl'],
    fontWeight: typography.medium,
  },
  balanceUsd: {
    fontSize: typography.md,
    marginTop: spacing.xs,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing['2xl'],
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: colors.primary,
    minHeight: touch.buttonHeight,
  },
  actionButtonPrimary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  actionButtonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  actionButtonText: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
    color: colors.primary,
  },
  actionButtonTextPrimary: {
    color: '#fff',
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing['2xl'],
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  sectionTitle: {
    fontSize: typography.lg,
    fontWeight: typography.semibold,
  },
  sectionAction: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
  },

  // Note Item
  noteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  noteLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  noteIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteInfo: {
    gap: 2,
  },
  noteAmount: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
    fontFamily: typography.mono,
  },
  noteStatus: {
    fontSize: typography.xs,
  },
  noteDate: {
    fontSize: typography.xs,
  },

  // Empty State
  emptyState: {
    padding: spacing['3xl'],
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  emptyTitle: {
    fontSize: typography.lg,
    fontWeight: typography.semibold,
    marginTop: spacing.sm,
  },
  emptySubtitle: {
    fontSize: typography.base,
    textAlign: 'center',
  },
  emptyButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    marginTop: spacing.md,
    minHeight: touch.buttonHeightSm,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: typography.base,
    fontWeight: typography.semibold,
  },
});
