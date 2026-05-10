/** @happy-dom */
import { describe, it, expect, afterEach } from "bun:test";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { AmountField } from "./amount-field";

afterEach(cleanup);

describe("AmountField", () => {
  it("renders with placeholder '0'", () => {
    render(
      <AmountField
        value=""
        onChange={() => {}}
        decimals={8}
        unit="BTC"
        availableBaseUnits={100_000_000n}
        usdPerUnit={50000}
      />,
    );
    expect(screen.getByPlaceholderText("0")).toBeDefined();
  });

  it("Max button fills the available amount minus a fee buffer", () => {
    let captured = "";
    render(
      <AmountField
        value=""
        onChange={(v) => {
          captured = v;
        }}
        decimals={8}
        unit="BTC"
        availableBaseUnits={100_000_000n}
        feeBufferBaseUnits={1000n}
        usdPerUnit={50000}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /max/i }));
    // (100_000_000 - 1_000) / 1e8 = 0.99999
    expect(captured).toBe("0.99999");
  });

  it("rejects characters that aren't digits or a single dot", () => {
    let captured = "";
    render(
      <AmountField
        value=""
        onChange={(v) => {
          captured = v;
        }}
        decimals={8}
        unit="BTC"
        availableBaseUnits={100_000_000n}
        usdPerUnit={50000}
      />,
    );
    const input = screen.getByPlaceholderText("0");
    fireEvent.change(input, { target: { value: "0.1abc" } });
    expect(captured).toBe("");
  });
});
