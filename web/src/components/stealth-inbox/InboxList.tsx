"use client";

import { useState, useMemo } from "react";
import { RefreshCw, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { InboxItem } from "./InboxItem";
import type { InboxNote } from "@/hooks/use-utxopia";

interface InboxListProps {
  notes: InboxNote[];
  isLoading: boolean;
  onRefresh: () => Promise<void>;
}

export function InboxList({ notes, isLoading, onRefresh }: InboxListProps) {
  const [showSpent, setShowSpent] = useState(false);

  const spendableNotes = useMemo(
    () => notes.filter((n) => !n.isSpent),
    [notes]
  );
  const spentNotes = useMemo(
    () => notes.filter((n) => n.isSpent),
    [notes]
  );
  const displayedNotes = showSpent ? notes : spendableNotes;

  return (
    <div className="flex flex-col">
      {/* Header with count + toggle + refresh */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-body2-semibold text-gray-light">
          {spendableNotes.length} Spendable{" "}
          {spendableNotes.length === 1 ? "Note" : "Notes"}
        </p>
        <div className="flex items-center gap-2">
          {spentNotes.length > 0 && (
            <button
              onClick={() => setShowSpent(!showSpent)}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption transition-colors",
                showSpent
                  ? "text-gray-light bg-gray/10"
                  : "text-gray hover:text-gray-light hover:bg-gray/10"
              )}
            >
              {showSpent ? (
                <EyeOff className="w-3.5 h-3.5" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
              {spentNotes.length} Spent
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption text-gray hover:text-gray-light hover:bg-gray/10 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* List */}
      <div className="space-y-3">
        {displayedNotes.map((note) => (
          <InboxItem key={note.id} note={note} onClaimed={onRefresh} />
        ))}
        {spendableNotes.length === 0 && !showSpent && (
          <div className="text-center py-6">
            <p className="text-body2 text-gray mb-2">No spendable notes</p>
            {spentNotes.length > 0 && (
              <button
                onClick={() => setShowSpent(true)}
                className="text-caption text-purple hover:text-purple/80 transition-colors"
              >
                Show {spentNotes.length} spent {spentNotes.length === 1 ? "note" : "notes"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
