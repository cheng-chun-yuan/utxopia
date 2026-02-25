/**
 * Receive Screen - Production Ready
 *
 * Three tabs:
 * 1. Address - Show stealth address QR for receiving zkBTC
 * 2. Request - Generate payment request QR/link
 * 3. Deposit - BTC deposit flow for native deposits
 *
 * Best Practices:
 * - Minimum 44px touch targets
 * - Clear visual hierarchy
 * - Accessible color contrast
 */

import { useState, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Share,
  Alert,
  ScrollView,
  ActivityIndicator,
  SafeAreaView,
  TextInput,
} from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useColorScheme } from '@/components/useColorScheme';
import { useWallet } from '@/contexts/WalletContext';
import { useNativeDeposit } from '@/contexts/SDKContext';
import { formatBtc } from '@zvault/sdk';
import {
  createPaymentRequestUrl,
  createShareMessage,
  shortenAddress,
} from '@/lib/payment-request';
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

type TabMode = 'address' | 'request' | 'deposit';

// ============================================================================
// Main Screen
// ============================================================================

export default function ReceiveScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const theme = useMemo(() => getThemeColors(isDark), [isDark]);

  const { isConnected, keysDerived, stealthAddress, deriveKeys, isDerivingKeys } =
    useWallet();

  const { isReady: depositsReady, createDeposit, pendingDeposits, confirmingDeposits } =
    useNativeDeposit();

  const [activeTab, setActiveTab] = useState<TabMode>('address');

  // Request tab state
  const [requestAmount, setRequestAmount] = useState('');
  const [requestMemo, setRequestMemo] = useState('');

  // Deposit tab state
  const [depositAmount, setDepositAmount] = useState('');
  const [isCreatingDeposit, setIsCreatingDeposit] = useState(false);
  const [currentDeposit, setCurrentDeposit] = useState<{
    address: string;
    amount: bigint;
  } | null>(null);

  // Generate payment request URL
  const paymentRequestUrl = useMemo(() => {
    if (!stealthAddress) return '';
    return createPaymentRequestUrl({
      to: stealthAddress,
      amount: requestAmount || undefined,
      memo: requestMemo || undefined,
    });
  }, [stealthAddress, requestAmount, requestMemo]);

  // Handlers
  const handleCopy = useCallback(async (text: string, label: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', `${label} copied to clipboard`);
  }, []);

  const handleShareAddress = useCallback(async () => {
    if (stealthAddress) {
      await Share.share({
        message: `My zVault stealth address:\n${stealthAddress}`,
      });
    }
  }, [stealthAddress]);

  const handleShareRequest = useCallback(async () => {
    if (!stealthAddress) return;

    const message = createShareMessage({
      to: stealthAddress,
      amount: requestAmount || undefined,
      memo: requestMemo || undefined,
    });

    await Share.share({ message });
  }, [stealthAddress, requestAmount, requestMemo]);

  const handleCreateDeposit = useCallback(async () => {
    const amountSats = Math.round(parseFloat(depositAmount || '0') * 100_000_000);
    if (amountSats <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid BTC amount');
      return;
    }

    setIsCreatingDeposit(true);
    try {
      const deposit = await createDeposit(BigInt(amountSats));
      setCurrentDeposit({
        address: deposit.taprootAddress,
        amount: BigInt(amountSats),
      });
    } catch (err) {
      Alert.alert('Error', 'Failed to create deposit address');
      console.error(err);
    } finally {
      setIsCreatingDeposit(false);
    }
  }, [depositAmount, createDeposit]);

  // ========== NOT CONNECTED ==========
  if (!isConnected) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.centerContent}>
          <FontAwesome name="user-times" size={48} color={theme.textMuted} />
          <Text style={[styles.centerText, { color: theme.textMuted }]}>
            Connect wallet to receive
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ========== KEYS NOT DERIVED ==========
  if (!keysDerived) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.centerContent}>
          <View style={[styles.iconContainer, { backgroundColor: colors.primaryLight }]}>
            <FontAwesome name="key" size={32} color={colors.primary} />
          </View>
          <Text style={[styles.centerTitle, { color: theme.text }]}>
            Derive Keys First
          </Text>
          <Text style={[styles.centerText, { color: theme.textMuted }]}>
            You need to derive your keys to get a stealth address
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
              isDerivingKeys && styles.buttonDisabled,
            ]}
            onPress={deriveKeys}
            disabled={isDerivingKeys}
          >
            <Text style={styles.primaryButtonText}>
              {isDerivingKeys ? 'Signing...' : 'Derive Keys'}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ========== MAIN VIEW ==========
  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      {/* Tab Switcher */}
      <View style={[styles.tabContainer, { backgroundColor: theme.card }]}>
        <Pressable
          style={[styles.tab, activeTab === 'address' && styles.tabActive]}
          onPress={() => setActiveTab('address')}
        >
          <FontAwesome
            name="qrcode"
            size={14}
            color={activeTab === 'address' ? '#fff' : theme.textMuted}
          />
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'address' ? '#fff' : theme.textMuted },
            ]}
          >
            Address
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === 'request' && styles.tabActive]}
          onPress={() => setActiveTab('request')}
        >
          <FontAwesome
            name="link"
            size={14}
            color={activeTab === 'request' ? '#fff' : theme.textMuted}
          />
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'request' ? '#fff' : theme.textMuted },
            ]}
          >
            Request
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === 'deposit' && styles.tabActive]}
          onPress={() => setActiveTab('deposit')}
        >
          <FontAwesome
            name="bitcoin"
            size={14}
            color={activeTab === 'deposit' ? '#fff' : theme.textMuted}
          />
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'deposit' ? '#fff' : theme.textMuted },
            ]}
          >
            Deposit
          </Text>
        </Pressable>
      </View>

      {/* ========== ADDRESS TAB ========== */}
      {activeTab === 'address' ? (
        <>
          <View style={[styles.qrCard, { backgroundColor: theme.card }]}>
            <View style={styles.qrWrapper}>
              <QRCode
                value={stealthAddress || 'zkey:...'}
                size={180}
                color="#000"
                backgroundColor="#fff"
              />
            </View>
            <Text style={[styles.qrLabel, { color: theme.textMuted }]}>
              Stealth Meta-Address
            </Text>
          </View>

          <View style={[styles.addressCard, { backgroundColor: theme.card }]}>
            <Text
              style={[styles.addressText, { color: theme.text }]}
              numberOfLines={3}
              selectable
            >
              {stealthAddress}
            </Text>
          </View>

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [
                styles.actionButton,
                { backgroundColor: theme.card },
                pressed && styles.buttonPressed,
              ]}
              onPress={() => handleCopy(stealthAddress!, 'Address')}
            >
              <FontAwesome name="copy" size={18} color={colors.primary} />
              <Text style={[styles.actionButtonText, { color: theme.text }]}>
                Copy
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.actionButton,
                { backgroundColor: theme.card },
                pressed && styles.buttonPressed,
              ]}
              onPress={handleShareAddress}
            >
              <FontAwesome name="share-alt" size={18} color={colors.primary} />
              <Text style={[styles.actionButtonText, { color: theme.text }]}>
                Share
              </Text>
            </Pressable>
          </View>

          <View style={[styles.notice, { backgroundColor: colors.successLight }]}>
            <FontAwesome name="shield" size={16} color={colors.success} />
            <Text style={[styles.noticeText, { color: theme.textSecondary }]}>
              Senders cannot link payments to your identity
            </Text>
          </View>
        </>
      ) : null}

      {/* ========== REQUEST TAB ========== */}
      {activeTab === 'request' ? (
        <>
          {/* Amount Input (Optional) */}
          <View style={[styles.inputCard, { backgroundColor: theme.card }]}>
            <Text style={[styles.inputLabel, { color: theme.textMuted }]}>
              Amount (Optional)
            </Text>
            <View style={styles.inputRow}>
              <FontAwesome name="bitcoin" size={20} color={colors.bitcoin} />
              <TextInput
                style={[styles.inputField, { color: theme.text }]}
                placeholder="0.00000000"
                placeholderTextColor={theme.textMuted}
                value={requestAmount}
                onChangeText={setRequestAmount}
                keyboardType="decimal-pad"
              />
              <Text style={[styles.inputUnit, { color: theme.textMuted }]}>BTC</Text>
            </View>
          </View>

          {/* Memo Input (Optional) */}
          <View style={[styles.inputCard, { backgroundColor: theme.card }]}>
            <Text style={[styles.inputLabel, { color: theme.textMuted }]}>
              Memo (Optional)
            </Text>
            <TextInput
              style={[styles.memoInput, { color: theme.text, borderColor: theme.border }]}
              placeholder="What's this payment for?"
              placeholderTextColor={theme.textMuted}
              value={requestMemo}
              onChangeText={setRequestMemo}
              multiline
              numberOfLines={2}
            />
          </View>

          {/* QR Code */}
          <View style={[styles.qrCard, { backgroundColor: theme.card }]}>
            <View style={styles.qrWrapper}>
              <QRCode
                value={paymentRequestUrl}
                size={180}
                color="#000"
                backgroundColor="#fff"
              />
            </View>
            <Text style={[styles.qrLabel, { color: theme.textMuted }]}>
              {requestAmount ? `Request for ${requestAmount} BTC` : 'Payment Request'}
            </Text>
          </View>

          {/* URL Preview */}
          <View style={[styles.urlCard, { backgroundColor: theme.card }]}>
            <Text style={[styles.urlLabel, { color: theme.textMuted }]}>
              Request Link
            </Text>
            <Text
              style={[styles.urlText, { color: theme.text }]}
              numberOfLines={2}
              selectable
            >
              {paymentRequestUrl}
            </Text>
          </View>

          {/* Actions */}
          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [
                styles.actionButton,
                { backgroundColor: theme.card },
                pressed && styles.buttonPressed,
              ]}
              onPress={() => handleCopy(paymentRequestUrl, 'Request link')}
            >
              <FontAwesome name="copy" size={18} color={colors.primary} />
              <Text style={[styles.actionButtonText, { color: theme.text }]}>
                Copy Link
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.actionButton,
                { backgroundColor: colors.primary },
                pressed && styles.buttonPressed,
              ]}
              onPress={handleShareRequest}
            >
              <FontAwesome name="share-alt" size={18} color="#fff" />
              <Text style={[styles.actionButtonText, { color: '#fff' }]}>
                Share
              </Text>
            </Pressable>
          </View>

          <View style={[styles.notice, { backgroundColor: colors.primaryLight }]}>
            <FontAwesome name="info-circle" size={16} color={colors.primary} />
            <Text style={[styles.noticeText, { color: theme.textSecondary }]}>
              Recipients can scan or tap the link to send you zkBTC directly
            </Text>
          </View>
        </>
      ) : null}

      {/* ========== DEPOSIT TAB ========== */}
      {activeTab === 'deposit' ? (
        <>
          {!currentDeposit ? (
            <>
              <View style={[styles.inputCard, { backgroundColor: theme.card }]}>
                <Text style={[styles.inputLabel, { color: theme.textMuted }]}>
                  Amount to Deposit
                </Text>
                <Pressable
                  style={styles.inputRow}
                  onPress={() => {
                    Alert.prompt(
                      'Enter Amount',
                      'How much BTC to deposit?',
                      (text) => setDepositAmount(text || ''),
                      'plain-text',
                      depositAmount,
                      'decimal-pad'
                    );
                  }}
                >
                  <FontAwesome name="bitcoin" size={24} color={colors.bitcoin} />
                  <Text style={[styles.inputValue, { color: theme.text }]}>
                    {depositAmount || '0.00000000'}
                  </Text>
                  <Text style={[styles.inputUnit, { color: theme.textMuted }]}>
                    BTC
                  </Text>
                </Pressable>
              </View>

              <Pressable
                style={({ pressed }) => [
                  styles.depositButton,
                  pressed && styles.buttonPressed,
                  (!depositsReady || isCreatingDeposit) && styles.buttonDisabled,
                ]}
                onPress={handleCreateDeposit}
                disabled={!depositsReady || isCreatingDeposit}
              >
                {isCreatingDeposit ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <FontAwesome name="bitcoin" size={18} color="#fff" />
                    <Text style={styles.depositButtonText}>
                      Generate Deposit Address
                    </Text>
                  </>
                )}
              </Pressable>

              {(pendingDeposits.length > 0 || confirmingDeposits.length > 0) ? (
                <View style={[styles.pendingCard, { backgroundColor: theme.card }]}>
                  <Text style={[styles.pendingTitle, { color: theme.text }]}>
                    Active Deposits
                  </Text>
                  {[...pendingDeposits, ...confirmingDeposits].map((deposit) => (
                    <View key={deposit.id} style={styles.pendingItem}>
                      <View>
                        <Text style={[styles.pendingAmount, { color: theme.text }]}>
                          {formatBtc(deposit.amount)} BTC
                        </Text>
                        <Text style={[styles.pendingStatus, { color: theme.textMuted }]}>
                          {deposit.status === 'waiting'
                            ? 'Waiting for deposit...'
                            : `${deposit.confirmations}/${deposit.requiredConfirmations} confirmations`}
                        </Text>
                      </View>
                      <Pressable
                        style={styles.copyIcon}
                        onPress={() => handleCopy(deposit.taprootAddress, 'Address')}
                      >
                        <FontAwesome name="copy" size={16} color={colors.primary} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          ) : (
            <>
              <View style={[styles.qrCard, { backgroundColor: theme.card }]}>
                <View style={styles.qrWrapper}>
                  <QRCode
                    value={`bitcoin:${currentDeposit.address}`}
                    size={180}
                    color="#000"
                    backgroundColor="#fff"
                  />
                </View>
                <Text style={[styles.qrLabel, { color: theme.textMuted }]}>
                  Send {formatBtc(currentDeposit.amount)} BTC
                </Text>
              </View>

              <View style={[styles.addressCard, { backgroundColor: theme.card }]}>
                <Text
                  style={[styles.addressText, { color: theme.text }]}
                  numberOfLines={2}
                  selectable
                >
                  {currentDeposit.address}
                </Text>
              </View>

              <Pressable
                style={({ pressed }) => [
                  styles.actionButtonFull,
                  { backgroundColor: theme.card },
                  pressed && styles.buttonPressed,
                ]}
                onPress={() => handleCopy(currentDeposit.address, 'Address')}
              >
                <FontAwesome name="copy" size={18} color={colors.primary} />
                <Text style={[styles.actionButtonText, { color: theme.text }]}>
                  Copy Address
                </Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.secondaryButton,
                  { borderColor: theme.border },
                  pressed && styles.buttonPressed,
                ]}
                onPress={() => setCurrentDeposit(null)}
              >
                <Text style={[styles.secondaryButtonText, { color: theme.text }]}>
                  Create Another
                </Text>
              </Pressable>

              <View style={[styles.notice, { backgroundColor: colors.bitcoinLight }]}>
                <FontAwesome name="clock-o" size={16} color={colors.bitcoin} />
                <Text style={[styles.noticeText, { color: theme.textSecondary }]}>
                  Wait for 2 confirmations (~20 min). Your zkBTC will appear
                  automatically.
                </Text>
              </View>
            </>
          )}
        </>
      ) : null}
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
    padding: spacing.lg,
    paddingBottom: spacing['5xl'],
  },

  // Center content
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['2xl'],
    gap: spacing.lg,
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerTitle: {
    fontSize: typography.xl,
    fontWeight: typography.semibold,
  },
  centerText: {
    fontSize: typography.base,
    textAlign: 'center',
  },

  // Tabs
  tabContainer: {
    flexDirection: 'row',
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: spacing.xs,
    marginBottom: spacing.xl,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    minHeight: touch.buttonHeightSm,
  },
  tabActive: {
    backgroundColor: colors.primary,
  },
  tabText: {
    fontSize: typography.xs,
    fontWeight: typography.semibold,
  },

  // QR Card
  qrCard: {
    alignItems: 'center',
    padding: spacing['2xl'],
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    gap: spacing.lg,
  },
  qrWrapper: {
    padding: spacing.lg,
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  qrLabel: {
    fontSize: typography.sm,
    fontWeight: typography.medium,
  },

  // Address Card
  addressCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    marginTop: spacing.md,
  },
  addressText: {
    fontSize: typography.xs,
    fontFamily: typography.mono,
    textAlign: 'center',
    lineHeight: typography.xs * 1.6,
  },

  // URL Card
  urlCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    marginTop: spacing.md,
  },
  urlLabel: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    marginBottom: spacing.sm,
  },
  urlText: {
    fontSize: typography.xs,
    fontFamily: typography.mono,
    lineHeight: typography.xs * 1.5,
  },

  // Input Card
  inputCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    marginBottom: spacing.md,
  },
  inputLabel: {
    fontSize: typography.xs,
    fontWeight: typography.medium,
    marginBottom: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  inputField: {
    flex: 1,
    fontSize: typography.xl,
    fontFamily: typography.mono,
    fontWeight: typography.semibold,
    paddingVertical: spacing.sm,
  },
  inputValue: {
    flex: 1,
    fontSize: typography['2xl'],
    fontFamily: typography.mono,
    fontWeight: typography.semibold,
  },
  inputUnit: {
    fontSize: typography.md,
  },
  memoInput: {
    fontSize: typography.base,
    paddingVertical: spacing.sm,
    minHeight: 60,
    textAlignVertical: 'top',
  },

  // Action Buttons
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
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
    minHeight: touch.buttonHeight,
  },
  actionButtonFull: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    marginTop: spacing.lg,
    minHeight: touch.buttonHeight,
  },
  actionButtonText: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
  },

  // Buttons
  primaryButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    minHeight: touch.buttonHeight,
    marginTop: spacing.sm,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: typography.md,
    fontWeight: typography.semibold,
    textAlign: 'center',
  },
  buttonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  secondaryButton: {
    borderWidth: 1.5,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    alignItems: 'center',
    marginTop: spacing.md,
    minHeight: touch.buttonHeight,
  },
  secondaryButtonText: {
    fontSize: typography.base,
    fontWeight: typography.medium,
  },

  // Notice
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    marginTop: spacing.xl,
  },
  noticeText: {
    flex: 1,
    fontSize: typography.sm,
    lineHeight: typography.sm * 1.5,
  },

  // Deposit Button
  depositButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bitcoin,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    gap: spacing.sm,
    minHeight: touch.buttonHeight,
  },
  depositButtonText: {
    color: '#fff',
    fontSize: typography.md,
    fontWeight: typography.semibold,
  },

  // Pending Card
  pendingCard: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  pendingTitle: {
    fontSize: typography.sm,
    fontWeight: typography.semibold,
    marginBottom: spacing.md,
  },
  pendingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  pendingAmount: {
    fontSize: typography.md,
    fontWeight: typography.semibold,
    fontFamily: typography.mono,
  },
  pendingStatus: {
    fontSize: typography.xs,
    marginTop: 2,
  },
  copyIcon: {
    padding: spacing.sm,
    minWidth: touch.iconButton,
    minHeight: touch.iconButton,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
