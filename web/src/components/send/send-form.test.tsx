/** @happy-dom */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = mock(() =>
    Promise.resolve({ ok: false, json: async () => null } as Response),
  ) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  cleanup();
});

// Stub the hooks the form depends on so the test stays unit-scoped.
mock.module("@/hooks/use-utxopia", () => ({
  useUTXOpia: () => ({
    keys: null,
    stealthAddress: null,
    hasKeys: false,
    inboxNotes: [],
    refreshInbox: () => {},
    refreshPublicBalance: () => {},
  }),
  useTokenNotes: () => ({
    availableNotes: [],
    totalBalance: 0n,
    isLoading: false,
  }),
}));
mock.module("@/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ btc: 50000, sol: null, usdc: null, usdt: null }),
}));
mock.module("@/hooks/use-note-auto-selector", () => ({
  useNoteAutoSelector: () => ({
    availableNotes: [],
    selectedNotes: [],
    totalAvailable: 0,
    totalSelected: 0,
    isLoading: false,
    refresh: () => {},
    hasNotes: false,
  }),
}));
mock.module("@/hooks/use-joinsplit-submit", () => ({
  useJoinSplitSubmit: () => ({
    status: "idle",
    statusMessage: "",
    txSignature: null,
    error: null,
    submit: async () => {},
    reset: () => {},
  }),
}));
mock.module("@/hooks/use-sns-name", () => ({
  useSnsName: () => ({
    lookupSnsName: async () => null,
    registeredSnsName: null,
    hasRegisteredSnsName: false,
    needsUpdate: false,
    isLoading: false,
    isRegistering: false,
    error: null,
    lookupMySnsName: async () => {},
    registerSnsSubdomain: async () => false,
    updateSnsStealthData: async () => false,
  }),
}));
// Note: not mocking @/hooks/use-relayer-config — bun's mock.module is global,
// and use-relayer-config.test.ts imports the real hook. Real useRelayerConfig
// is render-safe (initial state returns defaults; fetch fires in useEffect).
mock.module("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({ publicKey: null }),
}));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
}));
mock.module("./review-modal", () => ({
  ReviewModal: () => null,
}));
mock.module("./claim-link-modal", () => ({
  ClaimLinkModal: () => null,
}));

import { SendForm } from "./send-form";

describe("SendForm", () => {
  it("renders the recipient input first; amount and review hidden until valid", () => {
    render(<SendForm />);
    expect(screen.getByPlaceholderText(/paste address/i)).toBeDefined();
    expect(screen.queryByLabelText(/^amount$/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^send$/i }),
    ).toBeNull();
  });

  it("reveals the amount field after a valid recipient is entered", () => {
    render(<SendForm />);
    fireEvent.change(screen.getByPlaceholderText(/paste address/i), {
      target: { value: "bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe" },
    });
    expect(screen.getByLabelText(/^amount$/i)).toBeDefined();
  });
});
