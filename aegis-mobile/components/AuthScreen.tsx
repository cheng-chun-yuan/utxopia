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
        {/* Shield icon */}
        <View style={styles.iconContainer}>
          <Shield
            size={64}
            color={Colors.privacy}
            strokeWidth={1.5}
          />
        </View>

        {/* Title */}
        <Text style={styles.title}>Aegis</Text>
        <Text style={styles.subtitle}>Private Bitcoin Bridge</Text>

        {/* Spacer */}
        <View style={styles.spacer} />

        {/* Buttons */}
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
        </View>

        {/* Error display */}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  content: {
    width: "100%",
    alignItems: "center",
  },
  iconContainer: {
    marginBottom: 24,
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "rgba(20, 241, 149, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    fontSize: 36,
    fontWeight: "800",
    color: Colors.privacy,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: Colors.gray,
    marginTop: 4,
  },
  spacer: {
    height: 48,
  },
  buttonGroup: {
    width: "100%",
    gap: 12,
  },
  error: {
    color: Colors.error,
    fontSize: 14,
    textAlign: "center",
    marginTop: 16,
    paddingHorizontal: 8,
  },
});
