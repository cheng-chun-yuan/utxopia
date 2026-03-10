import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Linking,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useEventStream } from "@/hooks/use-event-stream";
import {
  useAnnouncements,
  useNullifiers,
  useTreeStatus,
  type AnnouncementRow,
} from "@/hooks/use-explorer";

type TabKey = "deposits" | "nullifiers" | "tree";

const TABS: { key: TabKey; label: string }[] = [
  { key: "deposits", label: "Deposits" },
  { key: "nullifiers", label: "Spends" },
  { key: "tree", label: "Tree" },
];

const EMPTY: Record<TabKey, string> = {
  deposits: "No deposits yet",
  nullifiers: "No spends yet",
  tree: "Tree is empty",
};

function AnnouncementRow({ item }: { item: AnnouncementRow }) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() =>
        Linking.openURL(
          `https://solscan.io/tx/${item.tx_signature}?cluster=devnet`,
        )
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: "rgba(255,255,255,0.04)",
      }}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text
          style={{
            fontSize: 12,
            fontFamily: "monospace",
            color: "#f1f0f3",
          }}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {item.commitment}
        </Text>
        <Text style={{ fontSize: 11, color: "#4a4a5a", marginTop: 2 }}>
          leaf #{item.leaf_index} ·{" "}
          {item.announcement_type === 0 ? "deposit" : "transfer"}
        </Text>
      </View>
      <Text style={{ fontSize: 11, color: "#4a4a5a" }}>
        slot {item.slot}
      </Text>
    </TouchableOpacity>
  );
}

function NullifierRow({ pda }: { pda: string }) {
  return (
    <View
      style={{
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: "rgba(255,255,255,0.04)",
      }}
    >
      <Text
        style={{
          fontSize: 12,
          fontFamily: "monospace",
          color: "#f1f0f3",
        }}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {pda}
      </Text>
    </View>
  );
}

function TabContent({ tabKey }: { tabKey: TabKey }) {
  const announcements = useAnnouncements();
  const nullifiers = useNullifiers();
  const treeStatus = useTreeStatus();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (tabKey === "deposits") await announcements.mutate();
    else if (tabKey === "nullifiers") await nullifiers.mutate();
    else await treeStatus.mutate();
    setRefreshing(false);
  }, [tabKey, announcements.mutate, nullifiers.mutate, treeStatus.mutate]);

  // Tree status tab
  if (tabKey === "tree") {
    if (treeStatus.isLoading && !treeStatus.data) {
      return (
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <ActivityIndicator color="#14f195" />
        </View>
      );
    }
    const s = treeStatus.data;
    return (
      <View style={{ paddingTop: 20, gap: 16 }}>
        <StatRow label="Root" value={s?.root ?? "—"} mono />
        <StatRow label="Size" value={String(s?.size ?? 0)} />
        <StatRow label="Next Index" value={String(s?.next_index ?? 0)} />
      </View>
    );
  }

  // Deposits tab
  if (tabKey === "deposits") {
    const loading = announcements.isLoading && !announcements.data;
    if (loading) {
      return (
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <ActivityIndicator color="#14f195" />
        </View>
      );
    }
    const items = announcements.data?.announcements ?? [];
    if (items.length === 0) {
      return (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingTop: 60,
          }}
        >
          <Text style={{ fontSize: 14, color: "#4a4a5a" }}>
            {EMPTY[tabKey]}
          </Text>
        </View>
      );
    }
    return (
      <FlatList
        data={items}
        keyExtractor={(item) => `${item.commitment}-${item.leaf_index}`}
        renderItem={({ item }) => <AnnouncementRow item={item} />}
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#14f195"
          />
        }
      />
    );
  }

  // Nullifiers tab
  const loading = nullifiers.isLoading && !nullifiers.data;
  if (loading) {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
      >
        <ActivityIndicator color="#14f195" />
      </View>
    );
  }
  const pdas = nullifiers.data?.pdas ?? [];
  if (pdas.length === 0) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingTop: 60,
        }}
      >
        <Text style={{ fontSize: 14, color: "#4a4a5a" }}>
          {EMPTY[tabKey]}
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      data={pdas}
      keyExtractor={(pda, i) => `${pda}-${i}`}
      renderItem={({ item }) => <NullifierRow pda={item} />}
      contentContainerStyle={{ paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#14f195"
        />
      }
    />
  );
}

function StatRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View>
      <Text style={{ fontSize: 11, color: "#6b6b7b", marginBottom: 4 }}>
        {label}
      </Text>
      <Text
        style={{
          fontSize: 13,
          fontFamily: mono ? "monospace" : undefined,
          color: "#f1f0f3",
        }}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {value}
      </Text>
    </View>
  );
}

export default function ActivityScreen() {
  const [tab, setTab] = useState<TabKey>("deposits");
  const { connected } = useEventStream();

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: "#0a0a0f" }}
      edges={["top"]}
    >
      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 8,
            paddingBottom: 16,
          }}
        >
          <Text
            style={{
              fontSize: 24,
              fontWeight: "800",
              color: "#f1f0f3",
              letterSpacing: -0.5,
            }}
          >
            Activity
          </Text>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: connected ? "#14f195" : "#4a4a5a",
            }}
          />
        </View>

        {/* Pill tabs */}
        <View
          style={{
            flexDirection: "row",
            backgroundColor: "#141419",
            borderRadius: 12,
            padding: 3,
            marginBottom: 16,
          }}
        >
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                activeOpacity={0.8}
                onPress={() => setTab(t.key)}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  alignItems: "center",
                  borderRadius: 10,
                  backgroundColor: active ? "#1e1e28" : "transparent",
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: active ? "700" : "500",
                    color: active ? "#f1f0f3" : "#6b6b7b",
                  }}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={{ flex: 1 }}>
          <TabContent tabKey={tab} />
        </View>
      </View>
    </SafeAreaView>
  );
}
