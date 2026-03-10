import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { ArrowDownLeft, ArrowUpRight, Copy, Check } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAegisStore } from "@/stores/aegis-store";
import { formatSats, truncateAddress } from "@/lib/utils";
import AuthScreen from "@/components/AuthScreen";

const W = Dimensions.get("window").width;
const BTN = (W - 52) / 2;

export default function WalletScreen() {
  const router = useRouter();
  const keys = useAegisStore((s) => s.keys);
  const stealthAddress = useAegisStore((s) => s.stealthAddress);
  const inboxNotes = useAegisStore((s) => s.inboxNotes);
  const refreshInbox = useAegisStore((s) => s.refreshInbox);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshInbox();
    setRefreshing(false);
  }, [refreshInbox]);

  if (!keys) return <AuthScreen />;

  const unspent = inboxNotes.filter((n) => !n.spent);
  const balance = unspent.reduce((s, n) => s + n.amount, 0);
  const btc = formatSats(balance);
  const [whole, dec] = btc.split(".");

  const go = (route: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push(route as never);
  };

  const copyAddr = async () => {
    if (!stealthAddress) return;
    await Clipboard.setStringAsync(stealthAddress);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0a0a0f" }} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#14f195" />
        }
      >
        {/* Brand */}
        <Text style={{ fontSize: 24, fontWeight: "800", color: "#14f195", letterSpacing: -0.5, paddingTop: 8, paddingBottom: 4 }}>
          Aegis
        </Text>

        {/* Balance card */}
        <View style={{ alignItems: "center", paddingTop: 40, paddingBottom: 12 }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: "#6b6b7b", letterSpacing: 2, marginBottom: 10, textTransform: "uppercase" }}>
            Shielded Balance
          </Text>
          <Text style={{ fontSize: 46, fontWeight: "800", color: "#f1f0f3", letterSpacing: -2 }}>
            <Text style={{ color: "#f7931a", fontSize: 34 }}>{"\u20BF"} </Text>
            {whole}
            <Text style={{ color: "#4a4a5a", fontWeight: "400" }}>.{dec}</Text>
          </Text>
        </View>

        {/* Address pill */}
        {stealthAddress ? (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={copyAddr}
            style={{
              flexDirection: "row",
              alignSelf: "center",
              alignItems: "center",
              gap: 6,
              backgroundColor: "#141419",
              borderRadius: 20,
              paddingHorizontal: 14,
              paddingVertical: 8,
              marginBottom: 32,
            }}
          >
            <Text style={{ fontSize: 12, color: "#6b6b7b", fontFamily: "monospace" }}>
              {truncateAddress(stealthAddress, 10)}
            </Text>
            {copied ? <Check size={12} color="#14f195" /> : <Copy size={12} color="#6b6b7b" />}
          </TouchableOpacity>
        ) : (
          <View style={{ height: 32 }} />
        )}

        {/* Action buttons */}
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => go("/deposit")}
            style={{
              width: BTN, height: 56, backgroundColor: "#14f195", borderRadius: 14,
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            <ArrowDownLeft size={18} color="#0a0a0f" strokeWidth={2.5} />
            <Text style={{ fontSize: 15, fontWeight: "700", color: "#0a0a0f" }}>Deposit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => go("/send")}
            style={{
              width: BTN, height: 56, backgroundColor: "#141419", borderRadius: 14,
              borderWidth: 1, borderColor: "rgba(255,255,255,0.08)",
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            <ArrowUpRight size={18} color="#14f195" strokeWidth={2.5} />
            <Text style={{ fontSize: 15, fontWeight: "700", color: "#14f195" }}>Send</Text>
          </TouchableOpacity>
        </View>

        {/* Notes */}
        <View style={{ marginTop: 32 }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: "#6b6b7b", letterSpacing: 1.5, marginBottom: 14, textTransform: "uppercase" }}>
            Shielded Notes
          </Text>

          {unspent.length === 0 ? (
            <View style={{
              backgroundColor: "#141419", borderRadius: 16, paddingVertical: 36, alignItems: "center",
              borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
            }}>
              <Text style={{ fontSize: 14, color: "#6b6b7b" }}>No shielded notes yet</Text>
              <Text style={{ fontSize: 12, color: "#4a4a5a", marginTop: 4 }}>Deposit BTC to get started</Text>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {unspent.map((note, i) => (
                <View
                  key={`${note.commitment}-${i}`}
                  style={{
                    backgroundColor: "#141419", borderRadius: 14, padding: 16,
                    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
                    borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: "#f1f0f3" }}>
                      {"\u20BF"} {formatSats(note.amount)}
                    </Text>
                    <Text style={{ fontSize: 11, color: "#6b6b7b", marginTop: 3 }}>
                      {note.amount.toLocaleString()} sats
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={{ fontSize: 11, color: "#14f195", fontWeight: "600" }}>
                      Leaf #{note.leafIndex}
                    </Text>
                    <Text style={{ fontSize: 11, color: "#4a4a5a", marginTop: 3 }}>
                      {new Date(note.timestamp * 1000).toLocaleDateString()}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
