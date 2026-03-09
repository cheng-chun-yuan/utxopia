import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Shield } from "lucide-react-native";
import { Colors } from "@/lib/colors";
import { Button } from "@/components/ui";
import { usePasskey } from "@/hooks/use-passkey";
import { useAegisStore } from "@/stores/aegis-store";

export default function AuthScreen() {
  const { isLoading, error, register, authenticate, hasCredential } =
    usePasskey();
  const deriveKeysFromSeed = useAegisStore((s) => s.deriveKeysFromSeed);
  const storeLoading = useAegisStore((s) => s.isLoading);

  const loading = isLoading || storeLoading;

  const handleRegister = async () => {
    const seed = await register();
    if (seed) {
      await deriveKeysFromSeed(seed);
    }
  };

  const handleAuthenticate = async () => {
    const seed = await authenticate();
    if (seed) {
      await deriveKeysFromSeed(seed);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Shield size={56} color={Colors.privacy} strokeWidth={1.5} />
        </View>

        <Text style={styles.title}>Aegis</Text>
        <Text style={styles.subtitle}>Private Bitcoin Bridge</Text>
      </View>

      <View style={styles.buttonGroup}>
        <Button
          variant="primary"
          size="lg"
          loading={loading && !hasCredential}
          disabled={loading}
          onPress={handleRegister}
          className="w-full"
        >
          Create Account
        </Button>

        <Button
          variant="secondary"
          size="lg"
          loading={loading && hasCredential}
          disabled={loading}
          onPress={handleAuthenticate}
          className="w-full"
        >
          Sign In
        </Button>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingHorizontal: 32,
    justifyContent: "space-between",
    paddingTop: "40%",
    paddingBottom: 64,
  },
  content: {
    alignItems: "center",
  },
  iconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(20, 241, 149, 0.08)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 32,
  },
  title: {
    fontSize: 40,
    fontWeight: "800",
    color: Colors.foreground,
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 16,
    color: Colors.gray,
    marginTop: 8,
    fontWeight: "400",
  },
  buttonGroup: {
    width: "100%",
    gap: 12,
  },
  error: {
    color: Colors.error,
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
  },
});
