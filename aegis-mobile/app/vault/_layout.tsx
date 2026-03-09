import { Stack } from "expo-router";

export default function VaultLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: "#0f0f12" },
        headerTintColor: "#f1f0f3",
        headerShadowVisible: false,
        contentStyle: { backgroundColor: "#0f0f12" },
      }}
    >
      <Stack.Screen name="deposit" options={{ title: "Deposit BTC" }} />
      <Stack.Screen name="pay" options={{ title: "Send zkBTC" }} />
      <Stack.Screen name="received" options={{ title: "Received" }} />
      <Stack.Screen name="activity" options={{ title: "Activity" }} />
      <Stack.Screen name="claim" options={{ title: "Claim Deposit" }} />
    </Stack>
  );
}
