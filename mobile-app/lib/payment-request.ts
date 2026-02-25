/**
 * Payment Request Utilities
 *
 * Generate and parse payment request URLs for deep linking.
 * URL format: zvaultwallet://send?to=ADDRESS&amount=AMOUNT&memo=MEMO
 */

import * as Linking from 'expo-linking';

// ============================================================================
// Types
// ============================================================================

export interface PaymentRequest {
  /** Recipient stealth address (132 hex chars) */
  to: string;
  /** Amount in BTC (optional) */
  amount?: string;
  /** Payment memo/note (optional) */
  memo?: string;
}

export interface ParsedPaymentRequest extends PaymentRequest {
  /** Whether the URL was valid */
  isValid: boolean;
  /** Error message if invalid */
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

export const SCHEME = 'zvaultwallet';
export const SEND_PATH = 'send';

// ============================================================================
// URL Generation
// ============================================================================

/**
 * Generate a payment request URL
 *
 * @example
 * createPaymentRequestUrl({ to: 'abc123...', amount: '0.001' })
 * // => 'zvaultwallet://send?to=abc123...&amount=0.001'
 */
export function createPaymentRequestUrl(request: PaymentRequest): string {
  const params = new URLSearchParams();

  params.set('to', request.to);

  if (request.amount) {
    params.set('amount', request.amount);
  }

  if (request.memo) {
    params.set('memo', request.memo);
  }

  return `${SCHEME}://${SEND_PATH}?${params.toString()}`;
}

/**
 * Generate a web-compatible payment request URL
 * Falls back to app store if app not installed
 */
export function createWebPaymentUrl(request: PaymentRequest): string {
  // For web sharing, we can use a universal link format
  // For now, just use the app scheme
  return createPaymentRequestUrl(request);
}

/**
 * Create a shareable message with payment request
 */
export function createShareMessage(request: PaymentRequest, senderName?: string): string {
  const url = createPaymentRequestUrl(request);
  const amountStr = request.amount ? ` ${request.amount} BTC` : '';
  const memoStr = request.memo ? `\n\nNote: ${request.memo}` : '';
  const sender = senderName || 'Someone';

  return `${sender} is requesting${amountStr} via zVault.\n\nOpen in zVault Wallet:\n${url}${memoStr}`;
}

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Parse a payment request URL
 */
export function parsePaymentRequestUrl(url: string): ParsedPaymentRequest {
  try {
    const parsed = Linking.parse(url);

    // Check if it's a send request
    if (parsed.path !== SEND_PATH && parsed.path !== `/${SEND_PATH}`) {
      return {
        to: '',
        isValid: false,
        error: 'Invalid path - expected /send',
      };
    }

    const to = parsed.queryParams?.to as string;

    if (!to) {
      return {
        to: '',
        isValid: false,
        error: 'Missing recipient address',
      };
    }

    // Validate address format (132 hex chars)
    if (to.length !== 132 || !/^[0-9a-fA-F]+$/.test(to)) {
      return {
        to,
        isValid: false,
        error: 'Invalid stealth address format',
      };
    }

    const amount = parsed.queryParams?.amount as string | undefined;
    const memo = parsed.queryParams?.memo as string | undefined;

    // Validate amount if provided
    if (amount) {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        return {
          to,
          amount,
          isValid: false,
          error: 'Invalid amount',
        };
      }
    }

    return {
      to,
      amount,
      memo,
      isValid: true,
    };
  } catch (err) {
    return {
      to: '',
      isValid: false,
      error: err instanceof Error ? err.message : 'Failed to parse URL',
    };
  }
}

/**
 * Extract payment request from URL query params
 * Used when the app is opened via deep link
 */
export function extractPaymentRequest(
  queryParams: Record<string, string | string[] | undefined> | undefined
): ParsedPaymentRequest | null {
  if (!queryParams?.to) {
    return null;
  }

  const to = Array.isArray(queryParams.to) ? queryParams.to[0] : queryParams.to;
  const amount = queryParams.amount
    ? Array.isArray(queryParams.amount)
      ? queryParams.amount[0]
      : queryParams.amount
    : undefined;
  const memo = queryParams.memo
    ? Array.isArray(queryParams.memo)
      ? queryParams.memo[0]
      : queryParams.memo
    : undefined;

  // Validate address
  if (!to || to.length !== 132 || !/^[0-9a-fA-F]+$/.test(to)) {
    return {
      to: to || '',
      amount,
      memo,
      isValid: false,
      error: 'Invalid stealth address',
    };
  }

  return {
    to,
    amount,
    memo,
    isValid: true,
  };
}

// ============================================================================
// QR Code Data
// ============================================================================

/**
 * Format payment request for QR code
 * Uses the deep link URL format
 */
export function formatForQRCode(request: PaymentRequest): string {
  return createPaymentRequestUrl(request);
}

/**
 * Shorten address for display
 */
export function shortenAddress(address: string, chars: number = 8): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
