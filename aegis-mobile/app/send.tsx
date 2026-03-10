import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Share,
} from "react-native";
import {
  Shield,
  Bitcoin,
  ArrowRight,
  Send,
  Gift,
  Link2,
  Wallet,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useAegisStore } from "@/stores/aegis-store";
import { formatSats } from "@/lib/utils";

// ── Top-level mode ──────────────────────────────────────────────
type TopMode = "private" | "withdraw";

// ── Private sub-modes ───────────────────────────────────────────
type PrivateTarget = "address" | "note";

// ── Withdraw chains ─────────────────────────────────────────────
type WithdrawChain = "btc" | "sol";

export default function SendScreen() {
  const inboxNotes = useAegisStore((s) => s.inboxNotes);
  const unspent = inboxNotes.filter((n) => !n.spent);
  const balance = unspent.reduce((s, n) => s + n.amount, 0);

  const [mode, setMode] = useState<TopMode>("private");
  const [privateTarget, setPrivateTarget] = useState<PrivateTarget>("address");
  const [withdrawChain, setWithdrawChain] = useState<WithdrawChain>("btc");

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const accent = mode === "private" ? "#14f195" : "#f7931a";

  const setMax = () => setAmount(String(balance));

  const handleSend = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (!amount.trim() || Number(amount) <= 0) return Alert.alert("Missing", "Enter an amount");
    const sats = Math.round(Number(amount));
    if (sats > balance) return Alert.alert("Error", "Insufficient balance");

    if (mode === "private" && privateTarget === "address") {
      if (!to.trim()) return Alert.alert("Missing", "Enter a recipient");
      Alert.alert("Coming Soon", `Private transfer of ${sats.toLocaleString()} sats to ${to} via ZK proof.`);
    } else if (mode === "private" && privateTarget === "note") {
      // Generate claim link
      const claimId = `aegis_${Date.now().toString(36)}`;
      const link = `https://aegis.xyz/claim/${claimId}?amount=${sats}`;
      Alert.alert(
        "Share Note",
        `${sats.toLocaleString()} sats${memo ? ` — "${memo}"` : ""}`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Share Link",
            onPress: () => {
              Share.share({
                message: memo
                  ? `${memo}\n\nClaim ${sats.toLocaleString()} sats on Aegis:\n${link}`
                  : `Claim ${sats.toLocaleString()} sats on Aegis:\n${link}`,
              });
            },
          },
        ]
      );
    } else {
      if (!to.trim()) return Alert.alert("Missing", "Enter a destination address");
      const chain = withdrawChain === "btc" ? "Bitcoin" : "Solana";
      Alert.alert("Coming Soon", `Withdraw ${sats.toLocaleString()} sats to ${chain} address.`);
    }
  };

  const recipientPlaceholder = () => {
    if (mode === "withdraw") return withdrawChain === "btc" ? "tb1p..." : "So1...";
    return "aegis1... or name.btcpro.sol";
  };

  const recipientLabel = () => {
    if (mode === "withdraw") return withdrawChain === "btc" ? "BTC Address" : "Solana Address";
    return "Recipient";
  };

  const buttonLabel = () => {
    if (mode === "private" && privateTarget === "note") return "Create Note Link";
    if (mode === "withdraw") return withdrawChain === "btc" ? "Withdraw to BTC" : "Withdraw to SOL";
    return "Send Private";
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0a0a0f" }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={100}
    >
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 100 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Top mode toggle ──────────────────────────────── */}
        <View style={{ flexDirection: "row", backgroundColor: "#141419", borderRadius: 12, padding: 3, marginBottom: 16 }}>
          <PillTab
            active={mode === "private"}
            onPress={() => setMode("private")}
            icon={<Shield size={15} color={mode === "private" ? "#14f195" : "#6b6b7b"} />}
            label="Private"
          />
          <PillTab
            active={mode === "withdraw"}
            onPress={() => setMode("withdraw")}
            icon={<Wallet size={15} color={mode === "withdraw" ? "#f7931a" : "#6b6b7b"} />}
            label="Withdraw"
          />
        </View>

        {/* ── Private sub-options ──────────────────────────── */}
        {mode === "private" && (
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
            <ChipButton
              active={privateTarget === "address"}
              onPress={() => setPrivateTarget("address")}
              icon={<Send size={13} color={privateTarget === "address" ? "#14f195" : "#6b6b7b"} />}
              label="To Address"
              accent="#14f195"
            />
            <ChipButton
              active={privateTarget === "note"}
              onPress={() => setPrivateTarget("note")}
              icon={<Gift size={13} color={privateTarget === "note" ? "#14f195" : "#6b6b7b"} />}
              label="Share Note"
              accent="#14f195"
            />
          </View>
        )}

        {/* ── Withdraw chain selector ─────────────────────── */}
        {mode === "withdraw" && (
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
            <ChipButton
              active={withdrawChain === "btc"}
              onPress={() => setWithdrawChain("btc")}
              icon={<Bitcoin size={13} color={withdrawChain === "btc" ? "#f7931a" : "#6b6b7b"} />}
              label="Bitcoin"
              accent="#f7931a"
            />
            <ChipButton
              active={withdrawChain === "sol"}
              onPress={() => setWithdrawChain("sol")}
              icon={<View style={{ width: 13, height: 13, borderRadius: 7, backgroundColor: withdrawChain === "sol" ? "#9945ff" : "#6b6b7b" }} />}
              label="Solana"
              accent="#9945ff"
            />
          </View>
        )}

        {/* ── Hint ─────────────────────────────────────────── */}
        <Text style={{ fontSize: 13, color: "#6b6b7b", lineHeight: 20, marginBottom: 20 }}>
          {mode === "private" && privateTarget === "address"
            ? "Send to an Aegis stealth address or .btcpro.sol name. Fully private via ZK proof."
            : mode === "private" && privateTarget === "note"
            ? "Create a shareable link. Anyone with the link can claim the funds in the Aegis app."
            : withdrawChain === "btc"
            ? "Burn shielded note and receive BTC via FROST threshold signing."
            : "Burn shielded note and receive SOL-wrapped BTC on Solana."}
        </Text>

        {/* ── Recipient (not for note mode) ────────────────── */}
        {!(mode === "private" && privateTarget === "note") && (
          <>
            <Label text={recipientLabel()} />
            <TextInput
              value={to}
              onChangeText={setTo}
              placeholder={recipientPlaceholder()}
              placeholderTextColor="#3a3a4a"
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                backgroundColor: "#141419", borderRadius: 14, padding: 16,
                fontSize: 14, color: "#f1f0f3", fontFamily: "monospace",
                borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
                marginBottom: 20,
              }}
            />
          </>
        )}

        {/* ── Memo (note mode only) ────────────────────────── */}
        {mode === "private" && privateTarget === "note" && (
          <>
            <Label text="Message (optional)" />
            <TextInput
              value={memo}
              onChangeText={setMemo}
              placeholder="Happy birthday!"
              placeholderTextColor="#3a3a4a"
              autoCapitalize="sentences"
              style={{
                backgroundColor: "#141419", borderRadius: 14, padding: 16,
                fontSize: 14, color: "#f1f0f3",
                borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
                marginBottom: 20,
              }}
            />
          </>
        )}

        {/* ── Amount ───────────────────────────────────────── */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <Label text="Amount (sats)" />
          <TouchableOpacity activeOpacity={0.7} onPress={setMax}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: accent }}>MAX</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          placeholder="0"
          placeholderTextColor="#3a3a4a"
          keyboardType="numeric"
          style={{
            backgroundColor: "#141419", borderRadius: 14, padding: 16,
            fontSize: 28, fontWeight: "700", color: "#f1f0f3",
            borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
            marginBottom: 6,
          }}
        />
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 32 }}>
          <Text style={{ fontSize: 12, color: "#4a4a5a" }}>
            {amount ? `\u20BF ${formatSats(Number(amount) || 0)}` : " "}
          </Text>
          <Text style={{ fontSize: 12, color: "#4a4a5a" }}>
            Balance: {balance.toLocaleString()} sats
          </Text>
        </View>

        {/* ── Submit ───────────────────────────────────────── */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={handleSend}
          style={{
            backgroundColor: accent, borderRadius: 14, paddingVertical: 18,
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          {mode === "private" && privateTarget === "note" ? (
            <Link2 size={17} color="#0a0a0f" strokeWidth={2.5} />
          ) : (
            <ArrowRight size={17} color="#0a0a0f" strokeWidth={2.5} />
          )}
          <Text style={{ fontSize: 16, fontWeight: "700", color: "#0a0a0f" }}>
            {buttonLabel()}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Shared components ─────────────────────────────────────────────

function PillTab({ active, onPress, icon, label }: {
  active: boolean; onPress: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={{
        flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
        gap: 6, paddingVertical: 11, borderRadius: 10,
        backgroundColor: active ? "#1e1e28" : "transparent",
      }}
    >
      {icon}
      <Text style={{ fontSize: 14, fontWeight: active ? "700" : "500", color: active ? "#f1f0f3" : "#6b6b7b" }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function ChipButton({ active, onPress, icon, label, accent }: {
  active: boolean; onPress: () => void; icon: React.ReactNode; label: string; accent: string;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={{
        flexDirection: "row", alignItems: "center", gap: 6,
        paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10,
        backgroundColor: active ? `${accent}14` : "#141419",
        borderWidth: 1,
        borderColor: active ? `${accent}30` : "rgba(255,255,255,0.06)",
      }}
    >
      {icon}
      <Text style={{ fontSize: 13, fontWeight: active ? "600" : "500", color: active ? accent : "#6b6b7b" }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function Label({ text }: { text: string }) {
  return (
    <Text style={{ fontSize: 12, fontWeight: "600", color: "#6b6b7b", letterSpacing: 1.5, textTransform: "uppercase" }}>
      {text}
    </Text>
  );
}
