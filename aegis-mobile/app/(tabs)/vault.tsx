import { ScrollView, RefreshControl } from "react-native";
import { useState, useCallback } from "react";
import { ScreenContainer } from "@/components/ui";
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

  return (
    <ScreenContainer edges={["left", "right", "bottom"]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: 16,
          gap: 16,
          paddingBottom: 100,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.privacy}
          />
        }
      >
        <StealthAddressCard address={stealthAddress} />
        <BalanceCard balanceSats={balanceSats} />
        <QuickActions />
      </ScrollView>
    </ScreenContainer>
  );
}
