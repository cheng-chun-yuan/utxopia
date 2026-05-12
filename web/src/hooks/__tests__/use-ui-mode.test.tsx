/** @happy-dom */
import { describe, it, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { UiModeProvider, useUiMode } from "../use-ui-mode";
import type { ReactNode } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <UiModeProvider>{children}</UiModeProvider>
);

describe("useUiMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to 'lite' when no localStorage value", () => {
    const { result } = renderHook(() => useUiMode(), { wrapper });
    expect(result.current.mode).toBe("lite");
    expect(result.current.isAdvanced).toBe(false);
  });

  it("reads existing localStorage value", () => {
    localStorage.setItem("utxopia-ui-mode", "advanced");
    const { result } = renderHook(() => useUiMode(), { wrapper });
    expect(result.current.mode).toBe("advanced");
    expect(result.current.isAdvanced).toBe(true);
  });

  it("setMode updates localStorage and broadcasts", () => {
    const { result } = renderHook(() => useUiMode(), { wrapper });
    act(() => result.current.setMode("advanced"));
    expect(result.current.mode).toBe("advanced");
    expect(localStorage.getItem("utxopia-ui-mode")).toBe("advanced");
  });

  it("ignores invalid localStorage values (falls back to lite)", () => {
    localStorage.setItem("utxopia-ui-mode", "garbage");
    const { result } = renderHook(() => useUiMode(), { wrapper });
    expect(result.current.mode).toBe("lite");
  });
});
