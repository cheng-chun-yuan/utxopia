/**
 * Toast notification helpers for zVault
 *
 * Uses sonner for beautiful toast notifications
 */

import { toast } from "sonner";

/**
 * Show a success notification when a deposit is confirmed
 */
export function notifyDepositConfirmed(claimLink?: string) {
  toast.success("Deposit Confirmed!", {
    description: "Your BTC deposit has been verified. You can now claim your zBTC.",
    action: claimLink
      ? {
          label: "Claim Now",
          onClick: () => {
            window.location.href = `/claim?note=${encodeURIComponent(claimLink)}`;
          },
        }
      : undefined,
    duration: 10000, // 10 seconds
  });
}

/**
 * Show a notification when a deposit is detected
 */
export function notifyDepositDetected(confirmations: number, required: number) {
  toast("Deposit Detected", {
    description: `Waiting for confirmations (${confirmations}/${required})`,
    icon: "🔍",
    duration: 5000,
  });
}

/**
 * Show a notification when claim is successful
 */
export function notifyClaimSuccess(amount: number) {
  const btcAmount = (amount / 100_000_000).toFixed(8);
  toast.success("zBTC Claimed!", {
    description: `${btcAmount} zBTC has been added to your wallet`,
    duration: 8000,
  });
}

/**
 * Show a notification when withdrawal is submitted
 */
export function notifyWithdrawalSubmitted(btcAddress: string) {
  const shortAddress = `${btcAddress.slice(0, 10)}...${btcAddress.slice(-8)}`;
  toast.success("Withdrawal Submitted", {
    description: `BTC will be sent to ${shortAddress}`,
    duration: 8000,
  });
}

/**
 * Show an error notification
 */
export function notifyError(message: string) {
  toast.error("Error", {
    description: message,
    duration: 6000,
  });
}

/**
 * Show a warning notification
 */
export function notifyWarning(message: string) {
  toast.warning("Warning", {
    description: message,
    duration: 6000,
  });
}

/**
 * Show an info notification
 */
export function notifyInfo(title: string, message: string) {
  toast(title, {
    description: message,
    duration: 5000,
  });
}

/**
 * Show a stealth deposit received notification
 */
export function notifyStealthReceived(amount: number) {
  const btcAmount = (amount / 100_000_000).toFixed(8);
  toast.success("Stealth Deposit Received!", {
    description: `You received ${btcAmount} zBTC via stealth address`,
    action: {
      label: "View Inbox",
      onClick: () => {
        window.location.href = "/bridge/received";
      },
    },
    duration: 10000,
  });
}

/**
 * Show a notification when text is copied to clipboard
 */
export function notifyCopied(label: string) {
  toast.success(`${label} copied`, {
    duration: 2000,
  });
}

/**
 * Show a generic success notification
 */
export function notifySuccess(message: string) {
  toast.success("Success", {
    description: message,
    duration: 5000,
  });
}
