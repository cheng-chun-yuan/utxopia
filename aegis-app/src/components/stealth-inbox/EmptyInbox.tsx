"use client";

import { Inbox, Shield, RefreshCw } from "lucide-react";

interface EmptyInboxProps {
  hasKeys: boolean;
  onDeriveKeys?: () => void;
  onRefresh?: () => void;
  isLoading?: boolean;
}

export function EmptyInbox({ hasKeys, onDeriveKeys, onRefresh, isLoading }: EmptyInboxProps) {
  if (!hasKeys) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="rounded-full bg-privacy/10 p-4 mb-4">
          <Shield className="h-10 w-10 text-privacy" />
        </div>
        <p className="text-heading6 text-foreground mb-2">Derive Your Keys</p>
        <p className="text-body2 text-gray mb-4">
          Sign a message to derive your viewing keys and check for incoming deposits
        </p>
        <button
          onClick={onDeriveKeys}
          disabled={isLoading}
          className="btn-primary px-6"
        >
          {isLoading ? "Signing..." : "Derive Keys"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="rounded-full bg-gray/10 p-4 mb-4">
        <Inbox className="h-10 w-10 text-gray" />
      </div>
      <p className="text-heading6 text-foreground mb-2">No Incoming Deposits</p>
      <p className="text-body2 text-gray mb-4">
        When someone sends you zBTC via stealth address, it will appear here
      </p>
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      )}
    </div>
  );
}
