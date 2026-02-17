"use client";

import * as AlertDialog from "@radix-ui/react-dialog";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  variant?: "default" | "warning" | "danger";
}

const variantStyles = {
  default: {
    icon: "text-privacy bg-privacy/10",
    confirm: "bg-privacy hover:bg-privacy/80 text-background",
  },
  warning: {
    icon: "text-warning bg-warning/10",
    confirm: "bg-warning hover:bg-warning/80 text-background",
  },
  danger: {
    icon: "text-red-400 bg-red-500/10",
    confirm: "bg-red-500 hover:bg-red-600 text-white",
  },
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  variant = "default",
}: ConfirmDialogProps) {
  const styles = variantStyles[variant];

  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in fade-in-0" />
        <AlertDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50",
            "w-[90vw] max-w-md p-6 rounded-[20px]",
            "bg-card border border-gray/30",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-left-1/2 slide-in-from-top-[48%]",
            "focus:outline-none"
          )}
        >
          {/* Close button */}
          <AlertDialog.Close asChild>
            <button
              className="absolute right-4 top-4 p-1.5 rounded-full bg-gray/10 hover:bg-gray/20 text-gray transition-colors"
              aria-label="Close dialog"
            >
              <X className="w-4 h-4" />
            </button>
          </AlertDialog.Close>

          {/* Icon */}
          <div className="flex justify-center mb-4">
            <div className={cn("p-3 rounded-full", styles.icon)}>
              <AlertTriangle className="w-6 h-6" />
            </div>
          </div>

          {/* Content */}
          <AlertDialog.Title className="text-heading6 text-foreground text-center mb-2">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-body2 text-gray text-center mb-6">
            {description}
          </AlertDialog.Description>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleCancel}
              className={cn(
                "flex-1 py-3 px-4 rounded-[12px]",
                "text-body2 text-gray-light",
                "bg-gray/10 hover:bg-gray/15 transition-colors"
              )}
            >
              {cancelLabel}
            </button>
            <button
              onClick={handleConfirm}
              className={cn(
                "flex-1 py-3 px-4 rounded-[12px]",
                "text-body2 transition-colors",
                styles.confirm
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
