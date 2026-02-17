"use client";

// Re-export from Zustand store for backwards compatibility
export { useNoteStorage, type StoredNote } from "@/stores";

// Legacy provider - now a no-op, kept for backwards compatibility
export function NoteStorageProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
