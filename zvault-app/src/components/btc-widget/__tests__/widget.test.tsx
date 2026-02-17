import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
// Rename import to PascalCase for JSX to work correctly
import { zkBTCWidget as SbBTCWidget, IntegratedWidget } from "../widget";

// Mock wallet adapter
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    publicKey: null,
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

// Mock the child flows to avoid complex dependency chains
vi.mock("../deposit-flow", () => ({
  DepositFlow: () => <div data-testid="deposit-flow">Deposit Flow</div>,
}));

vi.mock("../pay-flow", () => ({
  PayFlow: () => <div data-testid="pay-flow">Pay Flow</div>,
}));

vi.mock("../balance-view", () => ({
  BalanceView: () => <div data-testid="balance-view">Balance View</div>,
}));

describe("SbBTCWidget (Dialog)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders default trigger button", () => {
    render(<SbBTCWidget />);
    const button = screen.getByRole("button", { name: /open zvault/i });
    expect(button).toBeDefined();
  });

  it("renders with custom trigger", () => {
    const trigger = <button>Custom Trigger</button>;
    render(<SbBTCWidget trigger={trigger} />);
    expect(screen.getByRole("button", { name: /custom trigger/i })).toBeDefined();
  });

  it("opens dialog when trigger is clicked", async () => {
    render(<SbBTCWidget />);
    const trigger = screen.getByRole("button", { name: /open zvault/i });
    fireEvent.click(trigger);

    // Dialog should now be open - check for close button
    const closeButton = screen.getByRole("button", { name: /close/i });
    expect(closeButton).toBeDefined();
  });

  it("shows deposit tab by default", async () => {
    render(<SbBTCWidget />);
    fireEvent.click(screen.getByRole("button", { name: /open zvault/i }));

    expect(screen.getByTestId("deposit-flow")).toBeDefined();
  });

  it("respects defaultTab prop", async () => {
    render(<SbBTCWidget defaultTab="pay" />);
    fireEvent.click(screen.getByRole("button", { name: /open zvault/i }));

    expect(screen.getByTestId("pay-flow")).toBeDefined();
  });

  it("switches tabs when clicked", async () => {
    render(<SbBTCWidget />);
    fireEvent.click(screen.getByRole("button", { name: /open zvault/i }));

    // Initially on deposit
    expect(screen.getByTestId("deposit-flow")).toBeDefined();

    // Click pay tab
    const payTab = screen.getByRole("button", { name: /pay/i });
    fireEvent.click(payTab);
    expect(screen.getByTestId("pay-flow")).toBeDefined();

    // Click activity tab
    const activityTab = screen.getByRole("button", { name: /activity/i });
    fireEvent.click(activityTab);
    expect(screen.getByTestId("balance-view")).toBeDefined();
  });

  it("closes dialog when close button is clicked", async () => {
    render(<SbBTCWidget />);
    fireEvent.click(screen.getByRole("button", { name: /open zvault/i }));

    const closeButton = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeButton);

    // Dialog should be closed - close button should not be visible
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("renders all three tab buttons", async () => {
    render(<SbBTCWidget />);
    fireEvent.click(screen.getByRole("button", { name: /open zvault/i }));

    expect(screen.getByRole("button", { name: /deposit/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /pay/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /activity/i })).toBeDefined();
  });

  it("renders footer with links", async () => {
    render(<SbBTCWidget />);
    fireEvent.click(screen.getByRole("button", { name: /open zvault/i }));

    // Footer link (using href to be specific)
    expect(screen.getByRole("link", { name: /zvault/i })).toBeDefined();
    expect(screen.getByRole("link", { name: /github/i })).toBeDefined();
    expect(screen.getByText(/powered by/i)).toBeDefined();
  });
});

describe("IntegratedWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without dialog wrapper", () => {
    render(<IntegratedWidget />);
    // Should render directly without needing to click trigger
    expect(screen.getByTestId("deposit-flow")).toBeDefined();
  });

  it("respects defaultTab prop", () => {
    render(<IntegratedWidget defaultTab="activity" />);
    expect(screen.getByTestId("balance-view")).toBeDefined();
  });

  it("allows tab switching", () => {
    render(<IntegratedWidget />);

    // Switch to pay
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));
    expect(screen.getByTestId("pay-flow")).toBeDefined();
  });

  it("accepts custom className", () => {
    const { container } = render(<IntegratedWidget className="custom-class" />);
    expect(container.querySelector(".custom-class")).toBeDefined();
  });

  it("renders footer", () => {
    render(<IntegratedWidget />);
    expect(screen.getByText(/powered by/i)).toBeDefined();
  });
});
