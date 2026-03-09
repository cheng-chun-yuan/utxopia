import "../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Providers } from "./providers";

export default function RootLayout() {
  return (
    <Providers>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#0f0f12" },
          headerTintColor: "#f1f0f3",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: "#0f0f12" },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="vault" options={{ headerShown: false }} />
      </Stack>
    </Providers>
  );
}
