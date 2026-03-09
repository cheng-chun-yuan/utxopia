import { Tabs } from "expo-router";
import { Home, Shield, Search } from "lucide-react-native";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: "#0f0f12",
          borderTopColor: "rgba(139, 138, 158, 0.15)",
          borderTopWidth: 0.5,
          height: 85,
          paddingBottom: 30,
          paddingTop: 8,
        },
        tabBarActiveTintColor: "#14f195",
        tabBarInactiveTintColor: "#8b8a9e",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
        headerStyle: { backgroundColor: "#0f0f12" },
        headerTintColor: "#f1f0f3",
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="vault"
        options={{
          title: "Vault",
          tabBarIcon: ({ color, size }) => <Shield size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explorer"
        options={{
          title: "Explorer",
          tabBarIcon: ({ color, size }) => <Search size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
