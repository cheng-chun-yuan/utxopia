import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

// Mock SDK functions
const mockInitPoseidon = vi.fn();
const mockDeriveKeysFromWallet = vi.fn();
const mockCreateStealthMetaAddress = vi.fn();
const mockEncodeStealthMetaAddress = vi.fn();
const mockScanAnnouncements = vi.fn();
const mockParseStealthAnnouncement = vi.fn();
const mockAnnouncementToScanFormat = vi.fn();

vi.mock("@zvault/sdk", () => ({
  initPoseidon: () => mockInitPoseidon(),
  deriveKeysFromWallet: (wallet: unknown) => mockDeriveKeysFromWallet(wallet),
  createStealthMetaAddress: (keys: unknown) => mockCreateStealthMetaAddress(keys),
  encodeStealthMetaAddress: (meta: unknown) => mockEncodeStealthMetaAddress(meta),
  scanAnnouncements: (keys: unknown, announcements: unknown) => mockScanAnnouncements(keys, announcements),
  parseStealthAnnouncement: (data: unknown) => mockParseStealthAnnouncement(data),
  announcementToScanFormat: (parsed: unknown) => mockAnnouncementToScanFormat(parsed),
  STEALTH_ANNOUNCEMENT_SIZE: 105,
}));

vi.mock("@/lib/constants", () => ({
  ZVAULT_PROGRAM_ID: "MockProgramId1111111111111111111111111111111",
}));

import { useZVaultStore, useZVault, useZVaultKeys, useStealthInbox } from "../zvault-store";

describe("useZVaultStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    useZVaultStore.setState({
      isPoseidonReady: false,
      keys: null,
      stealthAddress: null,
      stealthAddressEncoded: null,
      isLoading: false,
      error: null,
      hasKeys: false,
      inboxNotes: [],
      inboxTotalSats: 0n,
      inboxDepositCount: 0,
      inboxLoading: false,
      inboxError: null,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("initial state", () => {
    it("starts with correct default values", () => {
      const { result } = renderHook(() => useZVaultStore());

      expect(result.current.isPoseidonReady).toBe(false);
      expect(result.current.keys).toBeNull();
      expect(result.current.stealthAddress).toBeNull();
      expect(result.current.stealthAddressEncoded).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.hasKeys).toBe(false);
      expect(result.current.inboxNotes).toEqual([]);
      expect(result.current.inboxTotalSats).toBe(0n);
      expect(result.current.inboxDepositCount).toBe(0);
      expect(result.current.inboxLoading).toBe(false);
      expect(result.current.inboxError).toBeNull();
    });
  });

  describe("initPoseidon", () => {
    it("sets isPoseidonReady to true on success", async () => {
      mockInitPoseidon.mockResolvedValue(undefined);

      const { result } = renderHook(() => useZVaultStore());

      await act(async () => {
        await result.current.initPoseidon();
      });

      expect(mockInitPoseidon).toHaveBeenCalled();
      expect(result.current.isPoseidonReady).toBe(true);
    });

    it("handles initialization error gracefully", async () => {
      mockInitPoseidon.mockRejectedValue(new Error("WASM init failed"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { result } = renderHook(() => useZVaultStore());

      await act(async () => {
        await result.current.initPoseidon();
      });

      expect(result.current.isPoseidonReady).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe("deriveKeys", () => {
    const mockWallet = {
      publicKey: { toBase58: () => "MockPublicKey" },
      signMessage: vi.fn(),
    };

    const mockKeys = {
      spendingKey: new Uint8Array(32),
      viewingKey: new Uint8Array(32),
    };

    const mockMetaAddress = {
      spendPubKey: new Uint8Array(33),
      viewPubKey: new Uint8Array(33),
    };

    it("derives keys successfully", async () => {
      mockDeriveKeysFromWallet.mockResolvedValue(mockKeys);
      mockCreateStealthMetaAddress.mockReturnValue(mockMetaAddress);
      mockEncodeStealthMetaAddress.mockReturnValue("st:mock-encoded-address");

      const { result } = renderHook(() => useZVaultStore());

      await act(async () => {
        await result.current.deriveKeys(mockWallet as any);
      });

      expect(mockDeriveKeysFromWallet).toHaveBeenCalledWith(mockWallet);
      expect(mockCreateStealthMetaAddress).toHaveBeenCalledWith(mockKeys);
      expect(result.current.keys).toBe(mockKeys);
      expect(result.current.stealthAddress).toBe(mockMetaAddress);
      expect(result.current.stealthAddressEncoded).toBe("st:mock-encoded-address");
      expect(result.current.hasKeys).toBe(true);
      expect(result.current.isLoading).toBe(false);
    });

    it("sets loading state during derivation", async () => {
      let resolveDerive: (value: unknown) => void;
      mockDeriveKeysFromWallet.mockReturnValue(
        new Promise((resolve) => {
          resolveDerive = resolve;
        })
      );
      mockCreateStealthMetaAddress.mockReturnValue(mockMetaAddress);
      mockEncodeStealthMetaAddress.mockReturnValue("encoded");

      const { result } = renderHook(() => useZVaultStore());

      // Start derivation
      act(() => {
        result.current.deriveKeys(mockWallet as any);
      });

      expect(result.current.isLoading).toBe(true);

      // Complete derivation
      await act(async () => {
        resolveDerive!(mockKeys);
      });

      expect(result.current.isLoading).toBe(false);
    });

    it("handles user rejection silently", async () => {
      const rejectionError = new Error("User rejected the request");
      rejectionError.name = "WalletSignMessageError";
      mockDeriveKeysFromWallet.mockRejectedValue(rejectionError);

      const { result } = renderHook(() => useZVaultStore());

      await act(async () => {
        await result.current.deriveKeys(mockWallet as any);
      });

      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.hasKeys).toBe(false);
    });

    it("handles JSON-RPC errors with friendly message", async () => {
      mockDeriveKeysFromWallet.mockRejectedValue(
        new Error("Internal JSON-RPC error")
      );

      const { result } = renderHook(() => useZVaultStore());

      await act(async () => {
        await result.current.deriveKeys(mockWallet as any);
      });

      expect(result.current.error).toBe("Wallet error - please try reconnecting");
      expect(result.current.isLoading).toBe(false);
    });

    it("handles other errors with error message", async () => {
      mockDeriveKeysFromWallet.mockRejectedValue(
        new Error("Network timeout")
      );

      const { result } = renderHook(() => useZVaultStore());

      await act(async () => {
        await result.current.deriveKeys(mockWallet as any);
      });

      expect(result.current.error).toBe("Network timeout");
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("clearKeys", () => {
    it("clears all key-related state", () => {
      // First set some state
      useZVaultStore.setState({
        keys: { spendingKey: new Uint8Array(32) } as any,
        stealthAddress: { spendPubKey: new Uint8Array(33) } as any,
        stealthAddressEncoded: "encoded",
        hasKeys: true,
        error: "some error",
        inboxNotes: [{ id: "1" } as any],
        inboxTotalSats: 100000n,
        inboxDepositCount: 1,
        inboxError: "inbox error",
      });

      const { result } = renderHook(() => useZVaultStore());

      act(() => {
        result.current.clearKeys();
      });

      expect(result.current.keys).toBeNull();
      expect(result.current.stealthAddress).toBeNull();
      expect(result.current.stealthAddressEncoded).toBeNull();
      expect(result.current.hasKeys).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.inboxNotes).toEqual([]);
      expect(result.current.inboxTotalSats).toBe(0n);
      expect(result.current.inboxDepositCount).toBe(0);
      expect(result.current.inboxError).toBeNull();
    });
  });

  describe("refreshInbox", () => {
    it("clears inbox when no keys are set", async () => {
      useZVaultStore.setState({
        keys: null,
        inboxNotes: [{ id: "1" } as any],
        inboxTotalSats: 100000n,
        inboxDepositCount: 1,
      });

      const mockConnection = {} as any;
      const { result } = renderHook(() => useZVaultStore());

      await act(async () => {
        await result.current.refreshInbox(mockConnection);
      });

      expect(result.current.inboxNotes).toEqual([]);
      expect(result.current.inboxTotalSats).toBe(0n);
      expect(result.current.inboxDepositCount).toBe(0);
    });
  });

  describe("useZVault convenience hook", () => {
    it("returns full store state", () => {
      const { result } = renderHook(() => useZVault());

      expect(result.current.isPoseidonReady).toBeDefined();
      expect(result.current.keys).toBeDefined();
      expect(result.current.inboxNotes).toBeDefined();
      expect(result.current.deriveKeys).toBeDefined();
      expect(result.current.clearKeys).toBeDefined();
      expect(result.current.refreshInbox).toBeDefined();
    });
  });

  describe("useZVaultKeys convenience hook", () => {
    it("returns keys-related state only", () => {
      const { result } = renderHook(() => useZVaultKeys());

      expect(result.current.keys).toBeDefined();
      expect(result.current.stealthAddress).toBeDefined();
      expect(result.current.stealthAddressEncoded).toBeDefined();
      expect(result.current.isLoading).toBeDefined();
      expect(result.current.error).toBeDefined();
      expect(result.current.deriveKeys).toBeDefined();
      expect(result.current.clearKeys).toBeDefined();
      expect(result.current.hasKeys).toBeDefined();

      // Should not include inbox-related state
      expect((result.current as any).inboxNotes).toBeUndefined();
    });
  });

  describe("useStealthInbox convenience hook", () => {
    it("returns inbox-related state only", () => {
      const { result } = renderHook(() => useStealthInbox());

      expect(result.current.notes).toBeDefined();
      expect(result.current.totalAmountSats).toBeDefined();
      expect(result.current.depositCount).toBeDefined();
      expect(result.current.isLoading).toBeDefined();
      expect(result.current.error).toBeDefined();
      expect(result.current.refresh).toBeDefined();
      expect(result.current.hasKeys).toBeDefined();

      // Should not include keys-related state
      expect((result.current as any).keys).toBeUndefined();
      expect((result.current as any).stealthAddress).toBeUndefined();
    });
  });
});
