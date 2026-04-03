"use client";

/**
 * usePayFlowNotes — manages note selection, auto-selection, secret phrase import,
 * and imported note tracking for the PayFlow component.
 *
 * Extracted from pay-flow.tsx to reduce component complexity.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { usePrivacyCoin, type InboxNote } from "@/hooks/use-privacy-coin";
import { autoSelectNotes, type PayToken } from "@/components/btc-widget/pay-flow/helpers";
import { scanSecretPhrase, type ScannedSecretNote } from "@/lib/claim-utils";

export function usePayFlowNotes(
  selectedToken: PayToken,
  totalOutputSats: number,
  hasKeys: boolean,
  initialSecretPhrase?: string,
  preselectedNote?: { commitment: string; leafIndex: number; amount: bigint },
  onPreselected?: () => void,
) {
  const {
    inboxNotes,
    inboxLoading,
    refreshInbox,
  } = usePrivacyCoin();

  // Input notes state
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const [showNoteSelector, setShowNoteSelector] = useState(false);
  const notePreselectedRef = useRef(false);

  // Imported note from secret phrase
  const [showImportInput, setShowImportInput] = useState(!!initialSecretPhrase);
  const [importPhrase, setImportPhrase] = useState(initialSecretPhrase || "");
  const [importedNotes, setImportedNotes] = useState<ScannedSecretNote[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importAutoTriggered = useRef(false);

  // Available unspent notes — filtered by selected token
  const availableNotes = useMemo(() => {
    return inboxNotes.filter((n) => n.amount > 0n && !n.isSpent && n.tokenSymbol === selectedToken.shieldedSymbol);
  }, [inboxNotes, selectedToken.shieldedSymbol]);

  // Selected notes
  const selectedNotes = useMemo(() => {
    return availableNotes.filter((n) => selectedNoteIds.has(n.id));
  }, [availableNotes, selectedNoteIds]);

  // Active unspent imported notes
  const activeImportedNotes = useMemo(() =>
    importedNotes.filter(n => !n.isSpent),
  [importedNotes]);
  const hasImportedNotes = activeImportedNotes.length > 0;

  // Total input sats (imported notes replace inbox notes when active)
  const totalInputSats = useMemo(() => {
    if (hasImportedNotes) return activeImportedNotes.reduce((sum, n) => sum + n.amount, 0);
    return selectedNotes.reduce((sum, n) => sum + Number(n.amount), 0);
  }, [selectedNotes, activeImportedNotes, hasImportedNotes]);

  // Pre-select note from props
  useEffect(() => {
    if (notePreselectedRef.current || inboxLoading || !preselectedNote) return;
    const matchingNote = availableNotes.find(
      (n) => n.commitmentHex === preselectedNote.commitment
    );
    if (matchingNote) {
      setSelectedNoteIds(new Set([matchingNote.id]));
      notePreselectedRef.current = true;
      onPreselected?.();
    }
  }, [preselectedNote, availableNotes, inboxLoading, onPreselected]);

  // Auto-select notes when total output changes
  useEffect(() => {
    if (notePreselectedRef.current) return; // Don't auto-select if user pre-selected
    if (totalOutputSats > 0 && availableNotes.length > 0) {
      setSelectedNoteIds(autoSelectNotes(availableNotes, totalOutputSats));
    }
  }, [totalOutputSats, availableNotes]);

  // Auto-import note from ?note= URL param
  useEffect(() => {
    if (!initialSecretPhrase || importAutoTriggered.current || !hasKeys) return;
    importAutoTriggered.current = true;
    handleImportScan(initialSecretPhrase);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSecretPhrase, hasKeys]);

  // Import scan handler
  const handleImportScan = useCallback(async (phrase?: string) => {
    const p = (phrase || importPhrase).trim();
    if (p.length < 8) {
      setImportError("Secret phrase must be at least 8 characters");
      return;
    }
    setImportLoading(true);
    setImportError(null);
    try {
      const results = await scanSecretPhrase(p);
      setImportedNotes(results);
      // When imported notes are active, clear inbox note selection
      setSelectedNoteIds(new Set());
      notePreselectedRef.current = true; // prevent auto-select from overriding
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to scan phrase");
    } finally {
      setImportLoading(false);
    }
  }, [importPhrase]);

  // Clear imported notes
  const clearImportedNote = useCallback(() => {
    setImportedNotes([]);
    setImportPhrase("");
    setImportError(null);
    setShowImportInput(false);
    notePreselectedRef.current = false;
  }, []);

  // Unified refresh: inbox + imported notes nullifier check
  const handleRefresh = useCallback(async () => {
    // Refresh wallet inbox
    refreshInbox();
    // Re-scan imported notes (re-fetches announcements + re-checks nullifiers)
    if (importPhrase.trim().length >= 8) {
      try {
        const results = await scanSecretPhrase(importPhrase.trim());
        setImportedNotes(results);
      } catch {
        // Keep existing imported notes on error
      }
    }
  }, [refreshInbox, importPhrase]);

  // Toggle note selection
  const toggleNoteSelection = useCallback((noteId: string) => {
    setSelectedNoteIds((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  }, []);

  return {
    // Inbox state (pass-through from usePrivacyCoin)
    inboxNotes,
    inboxLoading,
    refreshInbox,

    // Computed note lists
    availableNotes,
    selectedNotes,
    activeImportedNotes,
    hasImportedNotes,
    totalInputSats,

    // Note selection state & handlers
    selectedNoteIds,
    setSelectedNoteIds,
    showNoteSelector,
    setShowNoteSelector,
    toggleNoteSelection,

    // Import state & handlers
    showImportInput,
    setShowImportInput,
    importPhrase,
    setImportPhrase,
    importedNotes,
    importLoading,
    importError,
    setImportError,
    handleImportScan,
    clearImportedNote,

    // Refresh
    handleRefresh,
  };
}
