import { describe, it, expect } from "vitest";
import {
  formatBtc,
  formatSats,
  formatSatsWithBtc,
  formatUsd,
  truncateMiddle,
} from "../formatting";

describe("formatBtc", () => {
  it("formats satoshis as BTC with 8 decimal places", () => {
    expect(formatBtc(100_000_000)).toBe("1.00000000");
    expect(formatBtc(50_000_000)).toBe("0.50000000");
    expect(formatBtc(1)).toBe("0.00000001");
    expect(formatBtc(12345678)).toBe("0.12345678");
  });

  it("handles zero", () => {
    expect(formatBtc(0)).toBe("0.00000000");
  });

  it("handles large values", () => {
    expect(formatBtc(2_100_000_000_000_000)).toBe("21000000.00000000");
  });
});

describe("formatSats", () => {
  it("formats satoshis with locale grouping", () => {
    // Note: locale formatting varies, so we test that it contains digits
    const result = formatSats(1_000_000);
    expect(result).toMatch(/1.*000.*000/);
  });

  it("handles small values", () => {
    expect(formatSats(100)).toBe("100");
    expect(formatSats(1)).toBe("1");
  });

  it("handles zero", () => {
    expect(formatSats(0)).toBe("0");
  });
});

describe("formatSatsWithBtc", () => {
  it("formats as 'X sats (Y BTC)'", () => {
    const result = formatSatsWithBtc(100_000_000);
    expect(result).toContain("sats");
    expect(result).toContain("BTC");
    expect(result).toContain("1.00000000");
  });

  it("handles small amounts", () => {
    const result = formatSatsWithBtc(10_000);
    expect(result).toContain("sats");
    expect(result).toContain("0.00010000");
  });
});

describe("formatUsd", () => {
  it("formats with 2 decimal places", () => {
    expect(formatUsd(100)).toBe("100.00");
    expect(formatUsd(1234.567)).toBe("1,234.57");
    expect(formatUsd(0.1)).toBe("0.10");
  });

  it("handles zero", () => {
    expect(formatUsd(0)).toBe("0.00");
  });

  it("handles large values with grouping", () => {
    const result = formatUsd(1_000_000);
    expect(result).toMatch(/1.*000.*000\.00/);
  });
});

describe("truncateMiddle", () => {
  it("truncates long strings in the middle", () => {
    const longAddr = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const result = truncateMiddle(longAddr, 6);
    expect(result).toBe("bc1qar...wf5mdq");
    expect(result.length).toBeLessThan(longAddr.length);
  });

  it("returns original string if shorter than threshold", () => {
    expect(truncateMiddle("short", 6)).toBe("short");
    expect(truncateMiddle("exactly12", 6)).toBe("exactly12");
  });

  it("handles empty strings", () => {
    expect(truncateMiddle("")).toBe("");
  });

  it("handles custom visible char count", () => {
    const str = "abcdefghijklmnop";
    expect(truncateMiddle(str, 4)).toBe("abcd...mnop");
    expect(truncateMiddle(str, 2)).toBe("ab...op");
  });

  it("uses default of 6 visible chars", () => {
    const str = "abcdefghijklmnopqrst";
    const result = truncateMiddle(str);
    expect(result).toBe("abcdef...opqrst");
  });
});
