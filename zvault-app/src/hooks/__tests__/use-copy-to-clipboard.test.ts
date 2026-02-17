import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCopyToClipboard } from "../use-copy-to-clipboard";

// Mock clipboard API
const mockWriteText = vi.fn();
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

// Mock constants
vi.mock("@/lib/constants", () => ({
  COPY_TIMEOUT_MS: 1000,
}));

describe("useCopyToClipboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWriteText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts with copied = false", () => {
      const { result } = renderHook(() => useCopyToClipboard());
      expect(result.current.copied).toBe(false);
    });

    it("provides copy and reset functions", () => {
      const { result } = renderHook(() => useCopyToClipboard());
      expect(typeof result.current.copy).toBe("function");
      expect(typeof result.current.reset).toBe("function");
    });
  });

  describe("copy function", () => {
    it("copies text to clipboard", async () => {
      const { result } = renderHook(() => useCopyToClipboard());

      await act(async () => {
        result.current.copy("test text");
      });

      expect(mockWriteText).toHaveBeenCalledWith("test text");
    });

    it("sets copied to true after copying", async () => {
      const { result } = renderHook(() => useCopyToClipboard());

      await act(async () => {
        result.current.copy("test");
      });

      expect(result.current.copied).toBe(true);
    });

    it("resets copied to false after timeout", async () => {
      const { result } = renderHook(() => useCopyToClipboard({ timeout: 500 }));

      await act(async () => {
        result.current.copy("test");
      });

      expect(result.current.copied).toBe(true);

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(result.current.copied).toBe(false);
    });

    it("uses default timeout from constants", async () => {
      const { result } = renderHook(() => useCopyToClipboard());

      await act(async () => {
        result.current.copy("test");
      });

      expect(result.current.copied).toBe(true);

      // Advance less than default (1000ms from mock)
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(result.current.copied).toBe(true);

      // Advance past default timeout
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(result.current.copied).toBe(false);
    });

    it("handles rapid consecutive copies", async () => {
      const { result } = renderHook(() => useCopyToClipboard({ timeout: 1000 }));

      // First copy
      await act(async () => {
        result.current.copy("first");
      });
      expect(result.current.copied).toBe(true);

      // Advance 500ms
      act(() => {
        vi.advanceTimersByTime(500);
      });

      // Second copy (should reset timer)
      await act(async () => {
        result.current.copy("second");
      });
      expect(result.current.copied).toBe(true);

      // Advance 500ms more (total 1000ms from first copy, but only 500ms from second)
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(result.current.copied).toBe(true); // Still true because timer was reset

      // Advance another 500ms (now 1000ms from second copy)
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(result.current.copied).toBe(false);

      expect(mockWriteText).toHaveBeenCalledTimes(2);
    });

    it("handles clipboard write errors gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockWriteText.mockRejectedValueOnce(new Error("Clipboard write failed"));

      const { result } = renderHook(() => useCopyToClipboard());

      await act(async () => {
        result.current.copy("test");
        // Wait for error to propagate
        await Promise.resolve();
      });

      expect(consoleSpy).toHaveBeenCalled();
      // Still sets copied to true even on error (fire-and-forget pattern)
      expect(result.current.copied).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  describe("reset function", () => {
    it("sets copied to false immediately", async () => {
      const { result } = renderHook(() => useCopyToClipboard());

      await act(async () => {
        result.current.copy("test");
      });
      expect(result.current.copied).toBe(true);

      act(() => {
        result.current.reset();
      });
      expect(result.current.copied).toBe(false);
    });

    it("clears pending timeout", async () => {
      const { result } = renderHook(() => useCopyToClipboard({ timeout: 1000 }));

      await act(async () => {
        result.current.copy("test");
      });
      expect(result.current.copied).toBe(true);

      act(() => {
        result.current.reset();
      });
      expect(result.current.copied).toBe(false);

      // Advance past original timeout
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      // Copy again to verify state works correctly
      await act(async () => {
        result.current.copy("test2");
      });
      expect(result.current.copied).toBe(true);
    });

    it("is safe to call when nothing is copied", () => {
      const { result } = renderHook(() => useCopyToClipboard());

      expect(result.current.copied).toBe(false);

      act(() => {
        result.current.reset();
      });

      expect(result.current.copied).toBe(false);
    });
  });

  describe("cleanup on unmount", () => {
    it("clears timeout when hook unmounts", async () => {
      const { result, unmount } = renderHook(() =>
        useCopyToClipboard({ timeout: 1000 })
      );

      await act(async () => {
        result.current.copy("test");
      });
      expect(result.current.copied).toBe(true);

      unmount();

      // Should not throw even after timeout
      act(() => {
        vi.advanceTimersByTime(2000);
      });
    });
  });
});
