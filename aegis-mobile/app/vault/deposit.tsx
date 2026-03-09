import { QRDeposit } from "@/components/QRDeposit";
import { ScreenContainer } from "@/components/ui";

export default function DepositScreen() {
  return (
    <ScreenContainer scrollable>
      <QRDeposit />
    </ScreenContainer>
  );
}
