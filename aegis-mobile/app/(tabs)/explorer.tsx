import { View, Text } from "react-native";
import { ScreenContainer } from "@/components/ui";
import { Colors } from "@/lib/colors";

export default function ExplorerScreen() {
  return (
    <ScreenContainer edges={["left", "right", "bottom"]}>
      <View className="flex-1 items-center justify-center">
        <Text className="text-lg" style={{ color: Colors.grayLight }}>
          Explorer — Coming Soon
        </Text>
      </View>
    </ScreenContainer>
  );
}
