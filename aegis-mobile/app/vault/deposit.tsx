import { View, Text } from "react-native";
import { ScreenContainer } from "@/components/ui";
import { Colors } from "@/lib/colors";

export default function DepositScreen() {
  return (
    <ScreenContainer>
      <View className="flex-1 items-center justify-center">
        <Text className="text-lg" style={{ color: Colors.grayLight }}>
          Deposit — Coming Soon
        </Text>
      </View>
    </ScreenContainer>
  );
}
