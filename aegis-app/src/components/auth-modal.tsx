"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Fingerprint, Wallet, X, Shield, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  passkeySupported: boolean;
  hasPasskeyCredential: boolean;
  passkeyLoading: boolean;
  walletLoading: boolean;
  walletConnected: boolean;
  error: string | null;
  onPasskeyRegister: () => void;
  onPasskeyAuthenticate: () => void;
  onWalletConnect: () => void;
  onWalletDeriveKeys: () => void;
  onViewOnlyLogin?: (viewingKey: string) => void;
}

export function AuthModal({
  open,
  onOpenChange,
  passkeySupported,
  hasPasskeyCredential,
  passkeyLoading,
  walletLoading,
  walletConnected,
  error,
  onPasskeyRegister,
  onPasskeyAuthenticate,
  onWalletConnect,
  onWalletDeriveKeys,
  onViewOnlyLogin,
}: AuthModalProps) {
  const isLoading = passkeyLoading || walletLoading;
  const [showViewOnly, setShowViewOnly] = useState(false);
  const [viewingKeyInput, setViewingKeyInput] = useState("");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 animate-in fade-in-0 duration-200" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50",
            "w-[90vw] max-w-[400px] rounded-[20px]",
            "bg-card/95 backdrop-blur-xl border border-gray/20",
            "shadow-[0_0_80px_rgba(20,241,149,0.06),0_0_160px_rgba(153,69,255,0.04)]",
            "animate-in fade-in-0 zoom-in-95 duration-200",
            "focus:outline-none",
          )}
          aria-describedby="auth-modal-description"
        >
          {/* Close */}
          <Dialog.Close asChild>
            <button
              className="absolute right-4 top-4 p-1.5 rounded-full bg-gray/10 hover:bg-gray/20 text-gray transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </Dialog.Close>

          {/* Header */}
          <div className="pt-8 pb-2 px-6 text-center">
            <div className="inline-flex p-3 rounded-full bg-privacy/10 border border-privacy/20 mb-4">
              <Shield className="w-6 h-6 text-privacy" />
            </div>
            <Dialog.Title className="text-[20px] font-bold text-foreground mb-1">
              Unlock Your Vault
            </Dialog.Title>
            <Dialog.Description
              id="auth-modal-description"
              className="text-body2 text-gray"
            >
              Choose how to securely access your private Bitcoin
            </Dialog.Description>
          </div>

          {/* Error */}
          {error && (
            <div className="mx-6 mt-3 px-3 py-2 rounded-[8px] bg-red-500/10 border border-red-500/20">
              <p className="text-caption text-red-400 text-center">{error}</p>
              {error.includes("No saved key found") && passkeySupported && (
                <button
                  onClick={onPasskeyRegister}
                  disabled={isLoading}
                  className={cn(
                    "w-full mt-2 px-3 py-2 rounded-[8px]",
                    "bg-privacy/20 hover:bg-privacy/30 text-privacy",
                    "disabled:opacity-40 transition-colors text-caption font-semibold cursor-pointer",
                  )}
                >
                  Create New Passkey on This Device
                </button>
              )}
            </div>
          )}

          {/* Options */}
          <div className="p-6 space-y-3">
            {/* Passkey */}
            {passkeySupported && (
              <button
                onClick={
                  hasPasskeyCredential
                    ? onPasskeyAuthenticate
                    : onPasskeyRegister
                }
                disabled={isLoading}
                className={cn(
                  "w-full flex items-center gap-4 p-4 rounded-[14px]",
                  "bg-privacy/8 hover:bg-privacy/15 border border-privacy/15",
                  "hover:border-privacy/30 disabled:opacity-40",
                  "transition-all duration-200 cursor-pointer group",
                  "hover:shadow-[0_0_24px_rgba(20,241,149,0.08)]",
                )}
              >
                <div className="p-2.5 rounded-[10px] bg-privacy/12 group-hover:bg-privacy/20 transition-colors shrink-0">
                  <Fingerprint className="w-5 h-5 text-privacy" />
                </div>
                <div className="text-left min-w-0">
                  <p className="text-body2-semibold text-privacy">
                    {passkeyLoading
                      ? "Verifying..."
                      : hasPasskeyCredential
                        ? "Sign in with Passkey"
                        : "Create Passkey"}
                  </p>
                  <p className="text-caption text-gray mt-0.5">
                    Face ID, fingerprint, or device PIN
                  </p>
                </div>
              </button>
            )}

            {/* Wallet */}
            <button
              onClick={walletConnected ? onWalletDeriveKeys : onWalletConnect}
              disabled={isLoading}
              className={cn(
                "w-full flex items-center gap-4 p-4 rounded-[14px]",
                "bg-purple/8 hover:bg-purple/15 border border-purple/15",
                "hover:border-purple/30 disabled:opacity-40",
                "transition-all duration-200 cursor-pointer group",
                "hover:shadow-[0_0_24px_rgba(153,69,255,0.08)]",
              )}
            >
              <div className="p-2.5 rounded-[10px] bg-purple/12 group-hover:bg-purple/20 transition-colors shrink-0">
                <Wallet className="w-5 h-5 text-purple" />
              </div>
              <div className="text-left min-w-0">
                <p className="text-body2-semibold text-purple">
                  {walletLoading
                    ? "Unlocking..."
                    : walletConnected
                      ? "Sign to Unlock"
                      : "Connect Wallet"}
                </p>
                <p className="text-caption text-gray mt-0.5">
                  Phantom, Solflare, Backpack
                </p>
              </div>
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3 py-1">
              <div className="flex-1 h-px bg-gray/15" />
              <span className="text-caption text-gray/40 uppercase tracking-widest text-[10px]">
                or
              </span>
              <div className="flex-1 h-px bg-gray/15" />
            </div>

            {/* View Only */}
            {!showViewOnly ? (
              <button
                onClick={() => setShowViewOnly(true)}
                disabled={isLoading}
                className={cn(
                  "w-full flex items-center gap-4 p-4 rounded-[14px]",
                  "bg-btc/8 hover:bg-btc/15 border border-btc/15",
                  "hover:border-btc/30 disabled:opacity-40",
                  "transition-all duration-200 cursor-pointer group",
                  "hover:shadow-[0_0_24px_rgba(245,158,11,0.08)]",
                )}
              >
                <div className="p-2.5 rounded-[10px] bg-btc/12 group-hover:bg-btc/20 transition-colors shrink-0">
                  <Eye className="w-5 h-5 text-btc" />
                </div>
                <div className="text-left min-w-0">
                  <p className="text-body2-semibold text-btc">
                    View Only
                  </p>
                  <p className="text-caption text-gray mt-0.5">
                    Enter a viewing key to watch balances
                  </p>
                </div>
              </button>
            ) : (
              <div className="p-4 rounded-[14px] bg-btc/8 border border-btc/15 space-y-3">
                <div className="flex items-center gap-2">
                  <Eye className="w-4 h-4 text-btc shrink-0" />
                  <span className="text-body2-semibold text-btc">View Only Mode</span>
                </div>
                <input
                  type="text"
                  value={viewingKeyInput}
                  onChange={(e) => setViewingKeyInput(e.target.value.trim())}
                  placeholder="Paste viewing key (192 hex chars)"
                  className={cn(
                    "w-full px-3 py-2 bg-muted border border-gray/20 rounded-[8px]",
                    "text-caption font-mono text-foreground placeholder:text-gray/40",
                    "outline-none focus:border-btc/40 transition-colors"
                  )}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (viewingKeyInput && onViewOnlyLogin) {
                        onViewOnlyLogin(viewingKeyInput);
                      }
                    }}
                    disabled={!viewingKeyInput}
                    className={cn(
                      "flex-1 px-3 py-2 rounded-[8px]",
                      "bg-btc hover:bg-btc/80 text-background",
                      "disabled:bg-gray/30 disabled:text-gray disabled:cursor-not-allowed",
                      "transition-colors text-caption cursor-pointer"
                    )}
                  >
                    Enter
                  </button>
                  <button
                    onClick={() => { setShowViewOnly(false); setViewingKeyInput(""); }}
                    className="px-3 py-2 rounded-[8px] bg-gray/20 hover:bg-gray/30 text-gray-light text-caption transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
