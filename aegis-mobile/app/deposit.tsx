import React, { useState } from "react";
import { View, Text, TouchableOpacity, ScrollView } from "react-native";
import { Copy, Check, Bitcoin } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { useAegisStore } from "@/stores/aegis-store";
import { truncateAddress } from "@/lib/utils";

const POOL_ADDRESS = "tb1pksj664hdqkzvw2tlfvqshnevxt2qdutk47p9z964dkcsxazmf0vsjas4n4";

export default function DepositScreen() {
  const stealthAddress = useAegisStore((s) => s.stealthAddress);
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [copiedStealth, setCopiedStealth] = useState(false);

  const copy = async (text: string, setter: (v: boolean) => void) => {
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  if (!stealthAddress) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0a0a0f", alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: "#6b6b7b", fontSize: 14 }}>Create a wallet first</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#0a0a0f" }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 100 }}
    >
      {/* Steps */}
      <View style={{ gap: 16, marginBottom: 28 }}>
        <Step n={1} text="Copy the Taproot address below" />
        <Step n={2} text="Send any amount of BTC from your wallet" />
        <Step n={3} text="Your deposit is automatically shielded" />
      </View>

      {/* BTC Address */}
      <Label text="Send BTC to" />
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => copy(POOL_ADDRESS, setCopiedAddr)}
        style={{
          backgroundColor: "#141419", borderRadius: 14, padding: 16,
          borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
          flexDirection: "row", alignItems: "center", gap: 12,
          marginBottom: 10,
        }}
      >
        <View style={{
          width: 36, height: 36, borderRadius: 10,
          backgroundColor: "rgba(247,147,26,0.10)",
          alignItems: "center", justifyContent: "center",
        }}>
          <Bitcoin size={18} color="#f7931a" />
        </View>
        <Text style={{ flex: 1, fontSize: 13, fontFamily: "monospace", color: "#f7931a", lineHeight: 20 }} selectable>
          {POOL_ADDRESS}
        </Text>
        {copiedAddr ? <Check size={18} color="#14f195" /> : <Copy size={18} color="#6b6b7b" />}
      </TouchableOpacity>

      {/* Tags */}
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 28 }}>
        <Tag text="Testnet4" color="#f7931a" />
        <Tag text="Taproot" color="#14f195" />
      </View>

      {/* Stealth */}
      <Label text="Your stealth address" />
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => copy(stealthAddress, setCopiedStealth)}
        style={{
          backgroundColor: "#141419", borderRadius: 14, padding: 16,
          borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <Text style={{ fontSize: 13, fontFamily: "monospace", color: "#a3a3b5", flex: 1 }} numberOfLines={1}>
          {truncateAddress(stealthAddress, 14)}
        </Text>
        {copiedStealth ? <Check size={16} color="#14f195" /> : <Copy size={16} color="#6b6b7b" />}
      </TouchableOpacity>
      <Text style={{ fontSize: 12, color: "#4a4a5a", lineHeight: 18 }}>
        Included in OP_RETURN to link your deposit to your shielded wallet.
      </Text>
    </ScrollView>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{
        width: 28, height: 28, borderRadius: 14,
        backgroundColor: "#141419",
        alignItems: "center", justifyContent: "center",
        borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
      }}>
        <Text style={{ fontSize: 13, fontWeight: "700", color: "#14f195" }}>{n}</Text>
      </View>
      <Text style={{ fontSize: 14, color: "#f1f0f3", flex: 1 }}>{text}</Text>
    </View>
  );
}

function Label({ text }: { text: string }) {
  return (
    <Text style={{ fontSize: 12, fontWeight: "600", color: "#6b6b7b", letterSpacing: 1.5, marginBottom: 10, textTransform: "uppercase" }}>
      {text}
    </Text>
  );
}

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <View style={{ backgroundColor: `${color}14`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
      <Text style={{ fontSize: 11, fontWeight: "600", color }}>{text}</Text>
    </View>
  );
}
