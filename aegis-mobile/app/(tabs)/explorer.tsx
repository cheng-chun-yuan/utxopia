import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Linking,
  RefreshControl,
} from "react-native";
import { ScreenContainer, Spinner } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { truncateAddress } from "@/lib/utils";
import {
  useCommitments,
  useNullifiers,
  useProofs,
  type ExplorerItem,
} from "@/hooks/use-explorer";

type TabKey = "commitments" | "nullifiers" | "proofs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "commitments", label: "Commitments" },
  { key: "nullifiers", label: "Nullifiers" },
  { key: "proofs", label: "Proofs" },
];

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp * 1000;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function ExplorerItemRow({ item }: { item: ExplorerItem }) {
  const handlePress = useCallback(() => {
    Linking.openURL(
      `https://solscan.io/tx/${item.hash}?cluster=devnet`
    );
  }, [item.hash]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [styles.itemRow, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.itemHash}>{truncateAddress(item.hash, 10)}</Text>
      <Text style={styles.itemTime}>{formatRelativeTime(item.timestamp)}</Text>
    </Pressable>
  );
}

function TabContent({ tabKey }: { tabKey: TabKey }) {
  const commitments = useCommitments();
  const nullifiers = useNullifiers();
  const proofs = useProofs();

  const hookMap = { commitments, nullifiers, proofs };
  const { data, isLoading, mutate } = hookMap[tabKey];

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await mutate();
    setRefreshing(false);
  }, [mutate]);

  if (isLoading && !data) {
    return (
      <View style={styles.loadingContainer}>
        <Spinner size="lg" label="Loading..." />
      </View>
    );
  }

  const items = Array.isArray(data) ? data : [];

  if (items.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No {tabKey} found</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item, index) => `${item.hash}-${index}`}
      renderItem={({ item }) => <ExplorerItemRow item={item} />}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={Colors.privacy}
        />
      }
    />
  );
}

export default function ExplorerScreen() {
  const [activeTab, setActiveTab] = useState<TabKey>("commitments");

  return (
    <ScreenContainer edges={["left", "right", "bottom"]}>
      <Text style={styles.heading}>Explorer</Text>

      {/* Tab bar — text only, underline active */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              style={[styles.tab, isActive && styles.tabActive]}
            >
              <Text
                style={[styles.tabText, isActive && styles.tabTextActive]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.tabContent}>
        <TabContent tabKey={activeTab} />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 28,
    fontWeight: "700",
    color: Colors.foreground,
    marginTop: 8,
    marginBottom: 20,
    letterSpacing: -0.5,
  },
  tabBar: {
    flexDirection: "row",
    gap: 0,
    marginBottom: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: Colors.privacy,
  },
  tabText: {
    fontSize: 14,
    fontWeight: "500",
    color: Colors.gray,
  },
  tabTextActive: {
    color: Colors.foreground,
    fontWeight: "600",
  },
  tabContent: {
    flex: 1,
    marginTop: 8,
  },
  listContent: {
    paddingBottom: 32,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  itemHash: {
    fontSize: 14,
    fontFamily: "monospace",
    color: Colors.foreground,
  },
  itemTime: {
    fontSize: 13,
    color: Colors.gray,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 15,
    color: Colors.gray,
  },
});
