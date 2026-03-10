import * as LocalAuth from "expo-local-authentication";

/**
 * Prompt Face ID / Touch ID. Returns true if authenticated.
 */
export async function authenticateBiometric(): Promise<boolean> {
  const hasHardware = await LocalAuth.hasHardwareAsync();
  if (!hasHardware) return true; // No biometric hardware, skip

  const isEnrolled = await LocalAuth.isEnrolledAsync();
  if (!isEnrolled) return true; // No biometrics enrolled, skip

  const result = await LocalAuth.authenticateAsync({
    promptMessage: "Unlock Aegis",
    fallbackLabel: "Use Passcode",
    disableDeviceFallback: false,
  });

  return result.success;
}
