"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface StoredNote {
  commitment: string;
  noteExport: string;
  amountSats: number;
  taprootAddress: string;
  createdAt: number;
  expiresAt: number;
  depositId?: string;
  secretNote?: string;
  poseidonCommitment?: string;
  poseidonNote?: {
    amount: string;
    nullifier: string;
    secret: string;
    commitment?: string;
  };
}

interface NotesState {
  notes: StoredNote[];
  isLoaded: boolean;

  // Actions
  saveNote: (note: Omit<StoredNote, "createdAt">) => boolean;
  getNote: (commitment: string) => StoredNote | undefined;
  updateNote: (commitment: string, updates: Partial<StoredNote>) => void;
  deleteNote: (commitment: string) => boolean;
  clearNotes: () => boolean;
  getActiveNotes: () => StoredNote[];
}

export const useNotesStore = create<NotesState>()(
  persist(
    (set, get) => ({
      notes: [],
      isLoaded: true,

      saveNote: (note) => {
        const newNote: StoredNote = {
          ...note,
          createdAt: Date.now(),
        };
        set((state) => ({ notes: [...state.notes, newNote] }));
        return true;
      },

      getNote: (commitment) => {
        return get().notes.find((n) => n.commitment === commitment);
      },

      updateNote: (commitment, updates) => {
        set((state) => ({
          notes: state.notes.map((n) =>
            n.commitment === commitment ? { ...n, ...updates } : n
          ),
        }));
      },

      deleteNote: (commitment) => {
        set((state) => ({
          notes: state.notes.filter((n) => n.commitment !== commitment),
        }));
        return true;
      },

      clearNotes: () => {
        set({ notes: [] });
        return true;
      },

      getActiveNotes: () => {
        const now = Date.now();
        return get().notes.filter((note) => note.expiresAt * 1000 > now);
      },
    }),
    {
      name: "pcoin-notes",
    }
  )
);

// Convenience hook
export function useNoteStorage() {
  return useNotesStore();
}
