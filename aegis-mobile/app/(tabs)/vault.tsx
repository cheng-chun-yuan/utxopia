import { View, Text } from "react-native";
import { ScreenContainer } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { useAegisStore } from "@/stores/aegis-store";
import AuthScreen from "@/components/AuthScreen";

export default function VaultScreen() {
  const keys = useAegisStore((s) => s.keys);

  if (!keys) return <AuthScreen />;

  return (
    <ScreenContainer edges={["left", "right", "bottom"]}>
      <View className="flex-1 items-center justify-center">
        <Text className="text-lg" style={{ color: Colors.grayLight }}>
          Vault — Coming Soon
        </Text>
      </View>
    </ScreenContainer>
  );
}
