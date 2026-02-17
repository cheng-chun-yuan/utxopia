"use client";

import { AlertCircle } from "lucide-react";

interface ErrorCardProps {
  title?: string;
  message: string;
}

/**
 * Standardized error display card used across all flows.
 */
export function ErrorCard({ title = "Error", message }: ErrorCardProps) {
  return (
    <div className="flex items-center gap-3 p-3 bg-error/10 border border-error/20 rounded-[12px]">
      <AlertCircle className="w-5 h-5 text-error shrink-0" />
      <div className="flex flex-col">
        <span className="text-body2 text-error">{title}</span>
        {message && <span className="text-caption text-error/80">{message}</span>}
      </div>
    </div>
  );
}

/**
 * Inline error message for forms.
 */
export function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 p-2 bg-error/10 border border-error/20 rounded-[8px] text-error">
      <AlertCircle className="w-3 h-3 shrink-0" />
      <span className="text-caption">{message}</span>
    </div>
  );
}
