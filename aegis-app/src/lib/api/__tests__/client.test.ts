import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zBTCApi, zBTCApiClient, getDepositStatusFromMempool } from "../client";

// Mock fetch
global.fetch = vi.fn();

describe("zBTCApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("redeem", () => {
    it("sends correct request to redeem endpoint", async () => {
      const mockResponse = {
        request_id: "test_request_123",
        status: "pending",
        estimated_completion: Math.floor(Date.now() / 1000) + 3600,
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await zBTCApi.redeem(100_000_000, "bc1qtest", "solana_addr");

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/redeem"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );

      // Verify request body
      const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.amount_sats).toBe(100_000_000);
      expect(body.btc_address).toBe("bc1qtest");
      expect(body.solana_address).toBe("solana_addr");
    });

    it("throws ApiError on failed request", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: "Invalid amount" }),
      });

      await expect(zBTCApi.redeem(0, "bc1qtest", "solana")).rejects.toThrow();
    });
  });

  describe("getWithdrawalStatus", () => {
    it("fetches withdrawal status correctly", async () => {
      const mockResponse = {
        request_id: "test_request_123",
        status: "completed",
        btc_txid: "abc123def456",
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await zBTCApi.getWithdrawalStatus("test_request_123");

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/withdrawal/status/test_request_123"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("handles pending status", async () => {
      const mockResponse = {
        request_id: "pending_123",
        status: "pending",
        btc_txid: null,
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await zBTCApi.getWithdrawalStatus("pending_123");
      expect(result.status).toBe("pending");
      expect(result.btc_txid).toBeNull();
    });

    it("throws on 404 not found", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({ error: "Withdrawal not found" }),
      });

      await expect(zBTCApi.getWithdrawalStatus("invalid_id")).rejects.toThrow();
    });
  });

  describe("error handling", () => {
    it("handles network errors", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Network error")
      );

      await expect(zBTCApi.getWithdrawalStatus("test")).rejects.toThrow();
    });

    it("handles malformed JSON responses", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => { throw new Error("Invalid JSON"); },
      });

      await expect(zBTCApi.getWithdrawalStatus("test")).rejects.toThrow();
    });
  });

  describe("custom instance", () => {
    it("allows custom base URL", async () => {
      const customClient = new zBTCApiClient("https://custom-api.example.com");

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ request_id: "123", status: "pending" }),
      });

      await customClient.getWithdrawalStatus("123");

      expect(global.fetch).toHaveBeenCalledWith(
        "https://custom-api.example.com/api/withdrawal/status/123",
        expect.anything()
      );
    });
  });
});

describe("getDepositStatusFromMempool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns waiting status when address not found (404)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await getDepositStatusFromMempool("tb1ptest");

    expect(result.found).toBe(false);
    expect(result.status).toBe("waiting_payment");
    expect(result.can_claim).toBe(false);
    expect(result.confirmations).toBe(0);
    expect(result.required_confirmations).toBe(2);
  });

  it("returns waiting status when no transactions received", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        address: "tb1ptest",
        chain_stats: { funded_txo_sum: 0, funded_txo_count: 0, spent_txo_sum: 0, spent_txo_count: 0, tx_count: 0 },
        mempool_stats: { funded_txo_sum: 0, funded_txo_count: 0, spent_txo_sum: 0, spent_txo_count: 0, tx_count: 0 },
      }),
    });

    const result = await getDepositStatusFromMempool("tb1ptest");

    expect(result.found).toBe(false);
    expect(result.status).toBe("waiting_payment");
    expect(result.taproot_address).toBe("tb1ptest");
  });

  it("returns confirming status for unconfirmed transactions", async () => {
    // Mock address info with funds
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          address: "tb1ptest",
          chain_stats: { funded_txo_sum: 0 },
          mempool_stats: { funded_txo_sum: 100000 },
        }),
      })
      // Mock transactions
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          txid: "abc123",
          status: { confirmed: false },
          vout: [{ scriptpubkey_address: "tb1ptest", value: 100000 }],
        }],
      });

    const result = await getDepositStatusFromMempool("tb1ptest");

    expect(result.found).toBe(true);
    expect(result.escrow_status).toBe("confirming");
    expect(result.btc_txid).toBe("abc123");
    expect(result.amount_sats).toBe(100000);
    expect(result.can_claim).toBe(false);
  });

  it("returns can_claim true when enough confirmations", async () => {
    const blockHeight = 800000;
    const tipHeight = 800005; // 6 confirmations

    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          address: "tb1ptest",
          chain_stats: { funded_txo_sum: 50000 },
          mempool_stats: { funded_txo_sum: 0 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          txid: "confirmed_tx",
          status: { confirmed: true, block_height: blockHeight },
          vout: [{ scriptpubkey_address: "tb1ptest", value: 50000 }],
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => String(tipHeight),
      });

    const result = await getDepositStatusFromMempool("tb1ptest");

    expect(result.found).toBe(true);
    expect(result.can_claim).toBe(true);
    expect(result.confirmations).toBe(6);
    expect(result.escrow_status).toBe("passed");
  });

  it("handles fetch errors gracefully", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error")
    );

    const result = await getDepositStatusFromMempool("tb1ptest");

    expect(result.found).toBe(false);
    expect(result.status).toBe("waiting_payment");
  });

  it("handles missing vout address", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          address: "tb1ptest",
          chain_stats: { funded_txo_sum: 100000 },
          mempool_stats: { funded_txo_sum: 0 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          txid: "tx_without_match",
          status: { confirmed: true, block_height: 800000 },
          vout: [{ scriptpubkey_address: "different_address", value: 100000 }],
        }],
      });

    const result = await getDepositStatusFromMempool("tb1ptest");

    expect(result.found).toBe(false);
  });
});
