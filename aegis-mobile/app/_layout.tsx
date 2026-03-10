import "../polyfills";
import "../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Providers } from "./providers";
import { Colors } from "@/lib/colors";

export default function RootLayout() {
  return (
    <Providers>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: Colors.background },
          headerTintColor: Colors.foreground,
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: Colors.background },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="deposit"
          options={{
            title: "Deposit",
            presentation: "modal",
            headerStyle: { backgroundColor: Colors.background },
            headerTintColor: Colors.foreground,
          }}
        />
        <Stack.Screen
          name="send"
          options={{
            title: "Send",
            presentation: "modal",
            headerStyle: { backgroundColor: Colors.background },
            headerTintColor: Colors.foreground,
          }}
        />
      </Stack>
    </Providers>
  );
}
