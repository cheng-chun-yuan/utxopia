import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNotesStore, useNoteStorage, type StoredNote } from "../notes-store";

describe("useNotesStore", () => {
  // Reset store state before each test
  beforeEach(() => {
    const { result } = renderHook(() => useNotesStore());
    act(() => {
      result.current.clearNotes();
    });
  });

  describe("initial state", () => {
    it("starts with empty notes array", () => {
      const { result } = renderHook(() => useNotesStore());
      expect(result.current.notes).toEqual([]);
    });

    it("starts with isLoaded true", () => {
      const { result } = renderHook(() => useNotesStore());
      expect(result.current.isLoaded).toBe(true);
    });
  });

  describe("saveNote", () => {
    it("saves a note and returns true", () => {
      const { result } = renderHook(() => useNotesStore());

      const note: Omit<StoredNote, "createdAt"> = {
        commitment: "abc123",
        noteExport: "export-data",
        amountSats: 100000,
        taprootAddress: "tb1p...",
        expiresAt: Math.floor(Date.now() / 1000) + 86400, // 24 hours from now
      };

      let saveResult: boolean;
      act(() => {
        saveResult = result.current.saveNote(note);
      });

      expect(saveResult!).toBe(true);
      expect(result.current.notes).toHaveLength(1);
      expect(result.current.notes[0].commitment).toBe("abc123");
      expect(result.current.notes[0].createdAt).toBeDefined();
    });

    it("saves multiple notes", () => {
      const { result } = renderHook(() => useNotesStore());

      const baseNote: Omit<StoredNote, "createdAt"> = {
        commitment: "",
        noteExport: "export-data",
        amountSats: 100000,
        taprootAddress: "tb1p...",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      };

      act(() => {
        result.current.saveNote({ ...baseNote, commitment: "note1" });
        result.current.saveNote({ ...baseNote, commitment: "note2" });
        result.current.saveNote({ ...baseNote, commitment: "note3" });
      });

      expect(result.current.notes).toHaveLength(3);
    });

    it("preserves optional fields like secretNote", () => {
      const { result } = renderHook(() => useNotesStore());

      const note: Omit<StoredNote, "createdAt"> = {
        commitment: "abc123",
        noteExport: "export-data",
        amountSats: 100000,
        taprootAddress: "tb1p...",
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        secretNote: "secret-data",
        poseidonCommitment: "poseidon-commitment",
        poseidonNote: {
          amount: "100000",
          nullifier: "nullifier-hex",
          secret: "secret-hex",
        },
      };

      act(() => {
        result.current.saveNote(note);
      });

      expect(result.current.notes[0].secretNote).toBe("secret-data");
      expect(result.current.notes[0].poseidonCommitment).toBe("poseidon-commitment");
      expect(result.current.notes[0].poseidonNote).toEqual({
        amount: "100000",
        nullifier: "nullifier-hex",
        secret: "secret-hex",
      });
    });
  });

  describe("getNote", () => {
    it("returns undefined for non-existent commitment", () => {
      const { result } = renderHook(() => useNotesStore());

      const note = result.current.getNote("non-existent");
      expect(note).toBeUndefined();
    });

    it("returns the correct note by commitment", () => {
      const { result } = renderHook(() => useNotesStore());

      act(() => {
        result.current.saveNote({
          commitment: "target-commitment",
          noteExport: "target-export",
          amountSats: 50000,
          taprootAddress: "tb1p...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
        result.current.saveNote({
          commitment: "other-commitment",
          noteExport: "other-export",
          amountSats: 75000,
          taprootAddress: "tb1q...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
      });

      const note = result.current.getNote("target-commitment");
      expect(note?.noteExport).toBe("target-export");
      expect(note?.amountSats).toBe(50000);
    });
  });

  describe("deleteNote", () => {
    it("returns true and removes the note", () => {
      const { result } = renderHook(() => useNotesStore());

      act(() => {
        result.current.saveNote({
          commitment: "to-delete",
          noteExport: "export",
          amountSats: 100000,
          taprootAddress: "tb1p...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
      });

      expect(result.current.notes).toHaveLength(1);

      let deleteResult: boolean;
      act(() => {
        deleteResult = result.current.deleteNote("to-delete");
      });

      expect(deleteResult!).toBe(true);
      expect(result.current.notes).toHaveLength(0);
    });

    it("returns true even for non-existent commitment (no-op)", () => {
      const { result } = renderHook(() => useNotesStore());

      let deleteResult: boolean;
      act(() => {
        deleteResult = result.current.deleteNote("non-existent");
      });

      expect(deleteResult!).toBe(true);
    });

    it("only deletes the matching note", () => {
      const { result } = renderHook(() => useNotesStore());

      act(() => {
        result.current.saveNote({
          commitment: "keep1",
          noteExport: "export1",
          amountSats: 10000,
          taprootAddress: "tb1p1...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
        result.current.saveNote({
          commitment: "delete-me",
          noteExport: "export2",
          amountSats: 20000,
          taprootAddress: "tb1p2...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
        result.current.saveNote({
          commitment: "keep2",
          noteExport: "export3",
          amountSats: 30000,
          taprootAddress: "tb1p3...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
      });

      act(() => {
        result.current.deleteNote("delete-me");
      });

      expect(result.current.notes).toHaveLength(2);
      expect(result.current.notes.map((n) => n.commitment)).toEqual(["keep1", "keep2"]);
    });
  });

  describe("clearNotes", () => {
    it("returns true and removes all notes", () => {
      const { result } = renderHook(() => useNotesStore());

      act(() => {
        result.current.saveNote({
          commitment: "note1",
          noteExport: "export1",
          amountSats: 10000,
          taprootAddress: "tb1p...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
        result.current.saveNote({
          commitment: "note2",
          noteExport: "export2",
          amountSats: 20000,
          taprootAddress: "tb1q...",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        });
      });

      expect(result.current.notes).toHaveLength(2);

      let clearResult: boolean;
      act(() => {
        clearResult = result.current.clearNotes();
      });

      expect(clearResult!).toBe(true);
      expect(result.current.notes).toHaveLength(0);
    });
  });

  describe("getActiveNotes", () => {
    it("returns only non-expired notes", () => {
      const { result } = renderHook(() => useNotesStore());

      const now = Math.floor(Date.now() / 1000);

      act(() => {
        // Active note (expires in future)
        result.current.saveNote({
          commitment: "active",
          noteExport: "export1",
          amountSats: 10000,
          taprootAddress: "tb1p...",
          expiresAt: now + 86400, // 24 hours in future
        });
        // Expired note (expired in past)
        result.current.saveNote({
          commitment: "expired",
          noteExport: "export2",
          amountSats: 20000,
          taprootAddress: "tb1q...",
          expiresAt: now - 3600, // 1 hour ago
        });
      });

      const activeNotes = result.current.getActiveNotes();
      expect(activeNotes).toHaveLength(1);
      expect(activeNotes[0].commitment).toBe("active");
    });

    it("returns empty array when all notes are expired", () => {
      const { result } = renderHook(() => useNotesStore());

      const now = Math.floor(Date.now() / 1000);

      act(() => {
        result.current.saveNote({
          commitment: "expired1",
          noteExport: "export1",
          amountSats: 10000,
          taprootAddress: "tb1p...",
          expiresAt: now - 7200, // 2 hours ago
        });
        result.current.saveNote({
          commitment: "expired2",
          noteExport: "export2",
          amountSats: 20000,
          taprootAddress: "tb1q...",
          expiresAt: now - 3600, // 1 hour ago
        });
      });

      const activeNotes = result.current.getActiveNotes();
      expect(activeNotes).toHaveLength(0);
    });

    it("returns all notes when none are expired", () => {
      const { result } = renderHook(() => useNotesStore());

      const now = Math.floor(Date.now() / 1000);

      act(() => {
        result.current.saveNote({
          commitment: "active1",
          noteExport: "export1",
          amountSats: 10000,
          taprootAddress: "tb1p...",
          expiresAt: now + 86400,
        });
        result.current.saveNote({
          commitment: "active2",
          noteExport: "export2",
          amountSats: 20000,
          taprootAddress: "tb1q...",
          expiresAt: now + 172800, // 48 hours
        });
      });

      const activeNotes = result.current.getActiveNotes();
      expect(activeNotes).toHaveLength(2);
    });
  });

  describe("useNoteStorage backwards compatibility", () => {
    it("returns the same store interface", () => {
      const { result } = renderHook(() => useNoteStorage());

      expect(result.current.notes).toBeDefined();
      expect(result.current.saveNote).toBeDefined();
      expect(result.current.getNote).toBeDefined();
      expect(result.current.deleteNote).toBeDefined();
      expect(result.current.clearNotes).toBeDefined();
      expect(result.current.getActiveNotes).toBeDefined();
    });
  });
});
