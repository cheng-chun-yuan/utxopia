import React, { useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { Shield } from "lucide-react-native";
import { useAegisStore } from "@/stores/aegis-store";
import { loadSeed, storeSeed } from "@/lib/storage";
import { authenticateBiometric } from "@/lib/auth";

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

export default function AuthScreen() {
  const deriveKeysFromSeed = useAegisStore((s) => s.deriveKeysFromSeed);
  const isLoading = useAegisStore((s) => s.isLoading);
  const storeError = useAegisStore((s) => s.error);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleCreate = async () => {
    setAuthError(null);
    const ok = await authenticateBiometric();
    if (!ok) { setAuthError("Authentication required"); return; }
    const seed = getRandomBytes(32);
    await storeSeed(seed);
    await deriveKeysFromSeed(seed);
  };

  const handleRestore = async () => {
    setAuthError(null);
    const ok = await authenticateBiometric();
    if (!ok) { setAuthError("Authentication required"); return; }
    const seed = await loadSeed();
    if (seed) {
      await deriveKeysFromSeed(seed);
    } else {
      setAuthError("No wallet found");
    }
  };

  const error = authError || storeError;

  return (
    <View style={{ flex: 1, backgroundColor: "#0a0a0f", paddingHorizontal: 28, justifyContent: "space-between", paddingTop: "38%", paddingBottom: 100 }}>
      {/* Logo */}
      <View style={{ alignItems: "center" }}>
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: "rgba(20,241,149,0.08)", justifyContent: "center", alignItems: "center", marginBottom: 24 }}>
          <Shield size={40} color="#14f195" strokeWidth={1.5} />
        </View>
        <Text style={{ fontSize: 38, fontWeight: "800", color: "#14f195", letterSpacing: -1 }}>Aegis</Text>
        <Text style={{ fontSize: 14, color: "#6b6b7b", marginTop: 6 }}>Private Bitcoin Bridge</Text>
      </View>

      {/* Buttons */}
      <View style={{ gap: 12 }}>
        <TouchableOpacity
          activeOpacity={0.85}
          disabled={isLoading}
          onPress={handleCreate}
          style={{ backgroundColor: "#14f195", borderRadius: 14, paddingVertical: 18, alignItems: "center", opacity: isLoading ? 0.5 : 1 }}
        >
          {isLoading ? (
            <ActivityIndicator color="#0a0a0f" />
          ) : (
            <Text style={{ fontSize: 16, fontWeight: "700", color: "#0a0a0f" }}>Create Wallet</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.85}
          disabled={isLoading}
          onPress={handleRestore}
          style={{ backgroundColor: "#141419", borderRadius: 14, paddingVertical: 18, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", opacity: isLoading ? 0.5 : 1 }}
        >
          <Text style={{ fontSize: 16, fontWeight: "600", color: "#f1f0f3" }}>Restore Wallet</Text>
        </TouchableOpacity>

        {error ? (
          <Text style={{ color: "#ef4444", fontSize: 13, textAlign: "center", marginTop: 6 }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
