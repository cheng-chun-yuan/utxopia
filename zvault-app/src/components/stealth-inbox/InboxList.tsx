"use client";

import { RefreshCw } from "lucide-react";
import { InboxItem } from "./InboxItem";
import type { InboxNote } from "@/hooks/use-zvault";

interface InboxListProps {
  notes: InboxNote[];
  isLoading: boolean;
  onRefresh: () => Promise<void>;
}

export function InboxList({ notes, isLoading, onRefresh }: InboxListProps) {
  return (
    <div className="flex flex-col">
      {/* Header with refresh */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-body2-semibold text-gray-light">
          {notes.length} {notes.length === 1 ? "Note" : "Notes"} Found
        </p>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption text-gray hover:text-gray-light hover:bg-gray/10 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* List */}
      <div className="space-y-3">
        {notes.map((note) => (
          <InboxItem key={note.id} note={note} onClaimed={onRefresh} />
        ))}
      </div>
    </div>
  );
}
