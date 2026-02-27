/**
 * Connection Adapter Tests
 *
 * Tests for connection adapter factory functions.
 */

import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  createFetchConnectionAdapter,
  createConnectionAdapterFromWeb3,
  createConnectionAdapterFromKit,
  getConnectionAdapter,
  clearConnectionAdapterCache,
} from "../../src/solana/connection";

// =============================================================================
// Mock Setup
// =============================================================================

const originalFetch = global.fetch;

function mockFetch(response: unknown) {
  global.fetch = mock(
    () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(response),
      }) as Response,
  ) as unknown as typeof fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

// =============================================================================
// createFetchConnectionAdapter Tests
// =============================================================================

describe("createFetchConnectionAdapter", () => {
  afterEach(() => {
    restoreFetch();
  });

  test("creates adapter with endpoint", () => {
    const adapter = createFetchConnectionAdapter(
      "https://api.devnet.solana.com",
    );
    expect(adapter.getAccountInfo).toBeDefined();
    expect(typeof adapter.getAccountInfo).toBe("function");
  });

  test("returns null for non-existent account", async () => {
    mockFetch({
      jsonrpc: "2.0",
      id: 1,
      result: { value: null },
    });

    const adapter = createFetchConnectionAdapter(
      "https://api.devnet.solana.com",
    );
    const result = await adapter.getAccountInfo("NonExistentAddress11111111111111111111111");
    expect(result).toBeNull();
  });

  test("decodes base64 account data", async () => {
    mockFetch({
      jsonrpc: "2.0",
      id: 1,
      result: {
        value: {
          data: ["SGVsbG8=", "base64"],
          executable: false,
          lamports: 1000000,
          owner: "11111111111111111111111111111111",
          rentEpoch: 0,
        },
      },
    });

    const adapter = createFetchConnectionAdapter(
      "https://api.devnet.solana.com",
    );
    const result = await adapter.getAccountInfo("SomeAddress");

    expect(result).not.toBeNull();
    expect(result!.data).toEqual(
      new Uint8Array([72, 101, 108, 108, 111]),
    );
  });

  test("handles string data format", async () => {
    mockFetch({
      jsonrpc: "2.0",
      id: 1,
      result: {
        value: {
          data: "SGVsbG8=",
          executable: false,
          lamports: 1000000,
          owner: "11111111111111111111111111111111",
          rentEpoch: 0,
        },
      },
    });

    const adapter = createFetchConnectionAdapter(
      "https://api.devnet.solana.com",
    );
    const result = await adapter.getAccountInfo("SomeAddress");

    expect(result).not.toBeNull();
    expect(result!.data).toEqual(
      new Uint8Array([72, 101, 108, 108, 111]),
    );
  });
});

// =============================================================================
// createConnectionAdapterFromWeb3 Tests
// =============================================================================

describe("createConnectionAdapterFromWeb3", () => {
  test("wraps web3 connection", async () => {
    const mockConnection = {
      getAccountInfo: mock(() =>
        Promise.resolve({
          data: Buffer.from([1, 2, 3, 4]),
        }),
      ),
    };

    const adapter = createConnectionAdapterFromWeb3(
      mockConnection as unknown as { getAccountInfo: typeof mockConnection.getAccountInfo },
    );
    const result = await adapter.getAccountInfo("SomeAddress");

    expect(mockConnection.getAccountInfo).toHaveBeenCalledWith(
      "SomeAddress",
    );
    expect(result).not.toBeNull();
    expect(result!.data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("returns null for non-existent account", async () => {
    const mockConnection = {
      getAccountInfo: mock(() => Promise.resolve(null)),
    };

    const adapter = createConnectionAdapterFromWeb3(
      mockConnection as unknown as { getAccountInfo: typeof mockConnection.getAccountInfo },
    );
    const result = await adapter.getAccountInfo("NonExistent");

    expect(result).toBeNull();
  });
});

// =============================================================================
// createConnectionAdapterFromKit Tests
// =============================================================================

describe("createConnectionAdapterFromKit", () => {
  test("wraps kit rpc", async () => {
    const mockRpc = {
      getAccountInfo: mock(() => ({
        send: () =>
          Promise.resolve({
            value: {
              data: ["SGVsbG8=", "base64"],
            },
          }),
      })),
    };

    const adapter = createConnectionAdapterFromKit(
      mockRpc as unknown as { getAccountInfo: typeof mockRpc.getAccountInfo },
    );
    const result = await adapter.getAccountInfo("SomeAddress");

    expect(mockRpc.getAccountInfo).toHaveBeenCalledWith("SomeAddress", {
      encoding: "base64",
    });
    expect(result).not.toBeNull();
    expect(result!.data).toEqual(
      new Uint8Array([72, 101, 108, 108, 111]),
    );
  });
});

// =============================================================================
// getConnectionAdapter / clearConnectionAdapterCache Tests
// =============================================================================

describe("getConnectionAdapter / clearConnectionAdapterCache", () => {
  beforeEach(() => {
    clearConnectionAdapterCache();
  });

  afterEach(() => {
    clearConnectionAdapterCache();
  });

  test("returns same adapter instance for same endpoint", () => {
    const adapter1 = getConnectionAdapter("https://api.devnet.solana.com");
    const adapter2 = getConnectionAdapter("https://api.devnet.solana.com");

    expect(adapter1).toBe(adapter2);
  });

  test("returns different adapter instances for different endpoints", () => {
    const adapter1 = getConnectionAdapter("https://api.devnet.solana.com");
    const adapter2 = getConnectionAdapter("https://api.mainnet-beta.solana.com");

    expect(adapter1).not.toBe(adapter2);
  });
});

