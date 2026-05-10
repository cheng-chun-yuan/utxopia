/** @happy-dom */
import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { TokenSourcePicker } from "./token-source-picker";

afterEach(cleanup);

describe("TokenSourcePicker", () => {
  it("is disabled when recipient type is btc, locked to zkBTC", () => {
    render(
      <TokenSourcePicker
        recipientType="btc"
        selected="zkBTC"
        onSelect={() => {}}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/zkBTC/i)).toBeDefined();
  });

  it("is enabled for stealth_sns (any shielded token)", () => {
    render(
      <TokenSourcePicker
        recipientType="stealth_sns"
        selected="zkBTC"
        onSelect={() => {}}
      />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("is enabled for spl_wallet", () => {
    render(
      <TokenSourcePicker
        recipientType="spl_wallet"
        selected="zkBTC"
        onSelect={() => {}}
      />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });
});
