/**
 * Payment Request Context
 *
 * Manages incoming payment requests from deep links and QR codes.
 * Provides state that can be consumed by the send screen.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from 'react';
import * as Linking from 'expo-linking';
import {
  PaymentRequest,
  ParsedPaymentRequest,
  parsePaymentRequestUrl,
} from '@/lib/payment-request';

// ============================================================================
// Types
// ============================================================================

interface PaymentRequestContextValue {
  /** Current pending payment request */
  pendingRequest: ParsedPaymentRequest | null;
  /** Set a payment request (from QR scan, deep link, etc.) */
  setPaymentRequest: (request: PaymentRequest | null) => void;
  /** Clear the pending request */
  clearRequest: () => void;
  /** Whether there's a pending request */
  hasPendingRequest: boolean;
  /** Process a deep link URL */
  processDeepLink: (url: string) => ParsedPaymentRequest | null;
}

// ============================================================================
// Context
// ============================================================================

const PaymentRequestContext = createContext<PaymentRequestContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface PaymentRequestProviderProps {
  children: ReactNode;
}

export function PaymentRequestProvider({ children }: PaymentRequestProviderProps) {
  const [pendingRequest, setPendingRequest] = useState<ParsedPaymentRequest | null>(null);

  // Handle incoming deep links
  useEffect(() => {
    // Get initial URL if app was opened via deep link
    const handleInitialUrl = async () => {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        const parsed = parsePaymentRequestUrl(initialUrl);
        if (parsed.isValid) {
          console.log('[PaymentRequest] Initial deep link:', {
            to: parsed.to.slice(0, 16) + '...',
            amount: parsed.amount,
          });
          setPendingRequest(parsed);
        }
      }
    };

    handleInitialUrl();

    // Listen for deep links while app is open
    const subscription = Linking.addEventListener('url', (event) => {
      console.log('[PaymentRequest] Received deep link:', event.url);
      const parsed = parsePaymentRequestUrl(event.url);
      if (parsed.isValid) {
        console.log('[PaymentRequest] Valid payment request:', {
          to: parsed.to.slice(0, 16) + '...',
          amount: parsed.amount,
        });
        setPendingRequest(parsed);
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  // Process a deep link URL manually
  const processDeepLink = useCallback((url: string): ParsedPaymentRequest | null => {
    const parsed = parsePaymentRequestUrl(url);
    if (parsed.isValid) {
      setPendingRequest(parsed);
      return parsed;
    }
    return null;
  }, []);

  // Set payment request manually (from QR scan, etc.)
  const setPaymentRequest = useCallback((request: PaymentRequest | null) => {
    if (request) {
      const parsed: ParsedPaymentRequest = {
        ...request,
        isValid: true,
      };
      setPendingRequest(parsed);
    } else {
      setPendingRequest(null);
    }
  }, []);

  // Clear the pending request
  const clearRequest = useCallback(() => {
    setPendingRequest(null);
  }, []);

  const value: PaymentRequestContextValue = {
    pendingRequest,
    setPaymentRequest,
    clearRequest,
    hasPendingRequest: pendingRequest !== null && pendingRequest.isValid,
    processDeepLink,
  };

  return (
    <PaymentRequestContext.Provider value={value}>
      {children}
    </PaymentRequestContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function usePaymentRequest(): PaymentRequestContextValue {
  const context = useContext(PaymentRequestContext);
  if (!context) {
    throw new Error('usePaymentRequest must be used within PaymentRequestProvider');
  }
  return context;
}
