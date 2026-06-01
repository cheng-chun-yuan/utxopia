"use client";

import { Globe, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface SnsNameTipProps {
  parentDomain: string;
  open: boolean;
  value: string;
  error?: string | null;
  isRegistering: boolean;
  onOpen: () => void;
  onChange: (value: string) => void;
  onRegister: () => void;
  onCancel: () => void;
}

export function SnsNameTip({
  parentDomain,
  open,
  value,
  error,
  isRegistering,
  onOpen,
  onChange,
  onRegister,
  onCancel,
}: SnsNameTipProps) {
  if (open) {
    return (
      <div className="mb-5 rounded-[12px] border border-btc/20 bg-btc/5 p-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value.toLowerCase())}
              placeholder="yourname"
              className={cn(
                "w-full rounded-[8px] border border-gray/30 bg-muted px-3 py-2",
                "text-body2 text-foreground placeholder:text-gray",
                "outline-none transition-colors focus:border-btc/50",
              )}
            />
          </div>
          <span className="text-body2 text-gray">.{parentDomain}.sol</span>
        </div>
        {error && <p className="mb-2 text-caption text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRegister}
            disabled={isRegistering || !value}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-[8px] px-3 py-2",
              "bg-btc text-caption text-background transition-colors hover:bg-btc/80",
              "disabled:cursor-not-allowed disabled:bg-gray/30 disabled:text-gray",
            )}
          >
            {isRegistering ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Registering...
              </>
            ) : (
              <>
                <Globe className="h-3 w-3" />
                Register
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[8px] bg-gray/20 px-3 py-2 text-caption text-gray-light transition-colors hover:bg-gray/30"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-[12px] border border-btc/15 bg-btc/5 px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-btc">Tip</p>
          <p className="text-xs leading-5 text-gray/70">
            Make your private address easier to share with a name like{" "}
            <span className="font-mono text-btc/80">albert21.{parentDomain}.sol</span>.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[8px] border border-btc/20 px-3 py-2 text-xs text-btc transition-colors hover:bg-btc/10"
        >
          <Globe className="h-3.5 w-3.5" />
          Register name
        </button>
      </div>
    </div>
  );
}
