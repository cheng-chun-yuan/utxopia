/** @happy-dom */
import { describe, it, expect, mock } from "bun:test";
import { render, fireEvent, screen } from "@testing-library/react";

// Stub the hooks the form depends on so the test stays unit-scoped.
mock.module("@/hooks/use-privacy-coin", () => ({
  useTokenNotes: () => ({
    availableNotes: [],
    totalBalance: 0n,
    isLoading: false,
  }),
}));
mock.module("@/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ prices: { btc: 50000 } }),
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
