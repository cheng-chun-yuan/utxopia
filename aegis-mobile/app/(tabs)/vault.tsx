import { ScrollView, View, Text, StyleSheet, RefreshControl } from "react-native";
import { useState, useCallback } from "react";
import { useRouter } from "expo-router";
import { ArrowDownLeft } from "lucide-react-native";
import { ScreenContainer, Button } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { useAegisStore } from "@/stores/aegis-store";
import AuthScreen from "@/components/AuthScreen";
import StealthAddressCard from "@/components/StealthAddressCard";
import BalanceCard from "@/components/BalanceCard";
import QuickActions from "@/components/QuickActions";

export default function VaultScreen() {
  const keys = useAegisStore((s) => s.keys);
  const stealthAddress = useAegisStore((s) => s.stealthAddress);
  const inboxNotes = useAegisStore((s) => s.inboxNotes);
  const refreshInbox = useAegisStore((s) => s.refreshInbox);
  const router = useRouter();

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshInbox();
    setRefreshing(false);
  }, [refreshInbox]);

  if (!keys) return <AuthScreen />;

  const balanceSats = inboxNotes
    .filter((n) => !n.spent)
    .reduce((sum, n) => sum + n.amount, 0);

  const hasNotes = inboxNotes.length > 0;

  return (
    <ScreenContainer edges={["left", "right", "bottom"]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.privacy}
          />
        }
      >
        {/* Hero balance */}
        <BalanceCard balanceSats={balanceSats} />

        {/* Stealth address (subtle row, no card) */}
        {hasNotes && <StealthAddressCard address={stealthAddress} />}

        {/* Empty state */}
        {!hasNotes && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No shielded funds yet</Text>
            <Text style={styles.emptySub}>
              Deposit BTC to get started
            </Text>
            <Button
              variant="bitcoin"
              size="lg"
              onPress={() => router.push("/vault/deposit" as never)}
              className="mt-4"
            >
              <ArrowDownLeft size={18} color={Colors.background} />
              Deposit
            </Button>
          </View>
        )}

        {/* Quick actions 2x2 grid */}
        <View style={styles.actionsSection}>
          <QuickActions />
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 24,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: Colors.grayLight,
  },
  emptySub: {
    fontSize: 14,
    color: Colors.gray,
    marginTop: 4,
  },
  actionsSection: {
    marginTop: 24,
  },
});
