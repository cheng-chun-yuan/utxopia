/** @happy-dom */
import { describe, it, expect, afterEach } from "bun:test";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { RecipientInput } from "./recipient-input";

afterEach(cleanup);

describe("RecipientInput", () => {
  it("renders an empty input with placeholder", () => {
    render(<RecipientInput value="" onChange={() => {}} />);
    expect(
      screen.getByPlaceholderText(/paste address or .utxopia.sol/i),
    ).toBeDefined();
  });

  it("shows a green status row for a valid BTC address", () => {
    render(
      <RecipientInput
        value="bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/Bech32 Bitcoin address/i)).toBeDefined();
  });

  it("shows a red status row for invalid input", () => {
    render(<RecipientInput value="garbage" onChange={() => {}} />);
    expect(screen.getByText(/not a recognized/i)).toBeDefined();
  });

  it("calls onChange when typing", () => {
    let captured = "";
    render(
      <RecipientInput
        value=""
        onChange={(v) => {
          captured = v;
        }}
      />,
    );
    const input = screen.getByPlaceholderText(/paste address/i);
    fireEvent.change(input, { target: { value: "alice.utxopia.sol" } });
    expect(captured).toBe("alice.utxopia.sol");
  });
});
