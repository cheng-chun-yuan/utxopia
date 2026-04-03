"use client";

/**
 * useNoteAutoSelector — simplified note selection for single-output flows.
 * Auto-selects smallest notes to cover the requested amount.
 * No manual selection UI, no import scanning.
 */

import { useMemo } from "react";
import { usePrivacy Coin } from "@/hooks/use-privacy-coin";
import { autoSelectNotes } from "@/components/btc-widget/pay-flow/helpers";

export function useNoteAutoSelector(tokenSymbol: string, amountSats: number) {
  const { inboxNotes, inboxLoading, refreshInbox } = useAegis();

  const availableNotes = useMemo(
    () => inboxNotes.filter((n) => n.amount > 0n && !n.isSpent && n.tokenSymbol === tokenSymbol),
    [inboxNotes, tokenSymbol],
  );

  const totalAvailable = useMemo(
    () => availableNotes.reduce((sum, n) => sum + Number(n.amount), 0),
    [availableNotes],
  );

  const selectedNoteIds = useMemo(
    () => (amountSats > 0 ? autoSelectNotes(availableNotes, amountSats) : new Set<string>()),
    [availableNotes, amountSats],
  );

  const selectedNotes = useMemo(
    () => availableNotes.filter((n) => selectedNoteIds.has(n.id)),
    [availableNotes, selectedNoteIds],
  );

  const totalSelected = useMemo(
    () => selectedNotes.reduce((sum, n) => sum + Number(n.amount), 0),
    [selectedNotes],
  );

  return {
    availableNotes,
    selectedNotes,
    totalAvailable,
    totalSelected,
    isLoading: inboxLoading,
    refresh: refreshInbox,
    hasNotes: availableNotes.length > 0,
  };
}
