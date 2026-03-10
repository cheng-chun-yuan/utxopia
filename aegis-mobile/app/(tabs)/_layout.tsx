import { Tabs } from "expo-router";
import { Wallet, Clock } from "lucide-react-native";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: "#0a0a0f",
          borderTopColor: "rgba(255,255,255,0.06)",
          borderTopWidth: 0.5,
          height: 85,
          paddingBottom: 30,
          paddingTop: 8,
        },
        tabBarActiveTintColor: "#14f195",
        tabBarInactiveTintColor: "#4a4a5a",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Wallet",
          tabBarIcon: ({ color, size }) => <Wallet size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, size }) => <Clock size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
