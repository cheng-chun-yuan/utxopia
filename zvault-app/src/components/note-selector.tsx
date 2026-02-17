"use client";

import { useState } from "react";
import { Check, Wallet, Inbox, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBtc } from "@zvault/sdk";

/**
 * Owned note that can be selected for transfer
 */
export interface OwnedNote {
  /** Unique identifier */
  id: string;
  /** Amount in satoshis */
  amountSats: bigint;
  /** Commitment hash (hex) */
  commitment: string;
  /** Leaf index in merkle tree */
  leafIndex: number;
  /** Whether this note is claimed/minted */
  status: "pending" | "claimable" | "claimed";
  /** Optional label */
  label?: string;
  /** When the note was created */
  createdAt?: number;
}

interface NoteSelectorProps {
  /** Available notes to select from */
  notes: OwnedNote[];
  /** Currently selected note */
  selectedNote: OwnedNote | null;
  /** Callback when note is selected */
  onSelect: (note: OwnedNote) => void;
  /** Loading state */
  isLoading?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Additional class name */
  className?: string;
}

/**
 * Component to select an owned note for transfer
 */
export function NoteSelector({
  notes,
  selectedNote,
  onSelect,
  isLoading = false,
  disabled = false,
  className,
}: NoteSelectorProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Filter to only show claimable notes
  const availableNotes = notes.filter(
    (note) => note.status === "claimable" || note.status === "claimed"
  );

  const totalSats = availableNotes.reduce(
    (sum, note) => sum + note.amountSats,
    0n
  );

  if (isLoading) {
    return (
      <div className={cn("p-4 bg-muted rounded-xl border border-gray/15", className)}>
        <div className="flex items-center gap-3 animate-pulse">
          <div className="w-8 h-8 bg-gray/20 rounded-lg" />
          <div className="flex-1">
            <div className="h-4 w-24 bg-gray/20 rounded mb-1" />
            <div className="h-3 w-16 bg-gray/20 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (availableNotes.length === 0) {
    return (
      <div className={cn("p-4 bg-muted rounded-xl border border-gray/15", className)}>
        <div className="flex items-center gap-3 text-gray">
          <Inbox className="w-5 h-5" />
          <div>
            <p className="text-body2">No notes available</p>
            <p className="text-caption">
              Deposit BTC or receive a stealth transfer first
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-gray/15 overflow-hidden", className)}>
      {/* Header / Selected Note Display */}
      <button
        onClick={() => !disabled && setIsExpanded(!isExpanded)}
        disabled={disabled}
        className={cn(
          "w-full p-4 bg-muted text-left transition-colors",
          !disabled && "hover:bg-muted/80 cursor-pointer",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-btc/10 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-btc" />
            </div>
            <div>
              {selectedNote ? (
                <>
                  <p className="text-body2 text-foreground">
                    {formatBtc(selectedNote.amountSats)}
                  </p>
                  <p className="text-caption text-gray">
                    {selectedNote.label || `Note #${selectedNote.leafIndex}`}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-body2 text-gray-light">Select a note to send</p>
                  <p className="text-caption text-gray">
                    {availableNotes.length} note{availableNotes.length !== 1 ? "s" : ""} available
                  </p>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-caption text-gray">
              Total: {formatBtc(totalSats)}
            </span>
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-gray" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray" />
            )}
          </div>
        </div>
      </button>

      {/* Expanded Note List */}
      {isExpanded && (
        <div className="border-t border-gray/15 max-h-64 overflow-y-auto">
          {availableNotes.map((note) => {
            const isSelected = selectedNote?.id === note.id;

            return (
              <button
                key={note.id}
                onClick={() => {
                  onSelect(note);
                  setIsExpanded(false);
                }}
                disabled={disabled}
                className={cn(
                  "w-full p-3 flex items-center gap-3 text-left transition-colors",
                  "border-b border-gray/10 last:border-b-0",
                  isSelected
                    ? "bg-privacy/10 border-l-2 border-l-privacy"
                    : "bg-background hover:bg-muted/50"
                )}
              >
                {/* Selection indicator */}
                <div
                  className={cn(
                    "w-5 h-5 rounded-full border-2 flex items-center justify-center",
                    isSelected
                      ? "border-privacy bg-privacy"
                      : "border-gray/30 bg-transparent"
                  )}
                >
                  {isSelected && <Check className="w-3 h-3 text-background" />}
                </div>

                {/* Note info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-body2 text-foreground">
                      {formatBtc(note.amountSats)}
                    </span>
                    <span
                      className={cn(
                        "text-caption px-2 py-0.5 rounded-full",
                        note.status === "claimable"
                          ? "bg-success/10 text-success"
                          : note.status === "claimed"
                          ? "bg-btc/10 text-btc"
                          : "bg-gray/10 text-gray"
                      )}
                    >
                      {note.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-caption text-gray">
                      {note.label || `Note #${note.leafIndex}`}
                    </span>
                    <span className="text-caption text-gray/50">
                      {note.amountSats.toLocaleString()} sats
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default NoteSelector;
