"use client";

import { create } from "zustand";

export interface StoredNote {
  commitment: string;
  noteExport: string;
  amountSats: number;
  taprootAddress: string;
  createdAt: number;
  expiresAt: number;
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
  deleteNote: (commitment: string) => boolean;
  clearNotes: () => boolean;
  getActiveNotes: () => StoredNote[];
}

export const useNotesStore = create<NotesState>((set, get) => ({
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
}));

// Backwards compatible hook
export function useNoteStorage() {
  return useNotesStore();
}
