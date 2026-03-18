/**
 * @happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useCopyToClipboard } from "../use-copy-to-clipboard";

// Mock clipboard API
const mockWriteText = mock(() => Promise.resolve());

beforeEach(() => {
  mockWriteText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: mockWriteText },
    writable: true,
    configurable: true,
  });
});

describe("useCopyToClipboard", () => {
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

    it("handles clipboard write errors gracefully", async () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      mockWriteText.mockImplementationOnce(() => Promise.reject(new Error("fail")));

      const { result } = renderHook(() => useCopyToClipboard());

      await act(async () => {
        result.current.copy("test");
        await new Promise((r) => setTimeout(r, 10));
      });

      // Still sets copied to true (fire-and-forget)
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

    it("is safe to call when nothing is copied", () => {
      const { result } = renderHook(() => useCopyToClipboard());
      expect(result.current.copied).toBe(false);

      act(() => {
        result.current.reset();
      });
      expect(result.current.copied).toBe(false);
    });
  });
});
