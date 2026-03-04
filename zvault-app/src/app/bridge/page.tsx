"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowDownToLine,
  Wallet,
  Shield,
  Key,
  Copy,
  Check,
  Send,
  Loader2,
  LogOut,
  Search,
  ExternalLink,
  Globe,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FeatureCard, type FeatureCardColor } from "@/components/ui/feature-card";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useZVaultKeys } from "@/hooks/use-zvault";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useSnsName } from "@/hooks/use-sns-name";
import { useStealthInbox } from "@/hooks/use-zvault";
import { getConfig } from "@zvault/sdk";
import { notifyCopied } from "@/lib/notifications";
import { TooltipText } from "@/components/ui/tooltip";
import { OnboardingModal } from "@/components/onboarding-modal";

interface FeatureConfig {
  icon: React.ReactNode;
  title: string;
  description: string;
  subtext: string;
  href: string;
  color: FeatureCardColor;
  disabled?: boolean;
  badge?: string;
}

const features: FeatureConfig[] = [
  {
    icon: <ArrowDownToLine className="w-full h-full" />,
    title: "Deposit",
    description: "BTC → zkBTC",
    subtext: "Bridge Bitcoin",
    href: "/bridge/deposit",
    color: "btc",
  },
  {
    icon: <Send className="w-full h-full" />,
    title: "Pay",
    description: "Send zkBTC",
    subtext: "Public or Private",
    href: "/bridge/pay",
    color: "privacy",
  },
  {
    icon: <Wallet className="w-full h-full" />,
    title: "Notes",
    description: "All your zkBTC",
    subtext: "Claim & manage",
    href: "/bridge/activity",
    color: "privacy",
  },
  {
    icon: <Search className="w-full h-full" />,
    title: "Explorer",
    description: "On-chain data",
    subtext: "Commitments & proofs",
    href: "/explorer",
    color: "purple",
  },
];

export default function BridgePage() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const {
    keys,
    stealthAddressEncoded,
    isLoading,
    error,
    deriveKeys,
    clearKeys,
  } = useZVaultKeys();
  const { copied: snsCopied, copy: copySns } = useCopyToClipboard();
  const { copied: stealthCopied, copy: copyStealth } = useCopyToClipboard();
  const {
    registeredSnsName,
    hasRegisteredSnsName,
    needsUpdate: snsNeedsUpdate,
    isLoading: isLoadingSnsName,
    isRegistering: isRegisteringSns,
    error: snsError,
    registerSnsSubdomain,
    updateSnsStealthData,
  } = useSnsName();
  const {
    totalAmountSats,
    depositCount,
    isLoading: isLoadingInbox,
    refresh: refreshInbox,
  } = useStealthInbox();

  const snsConfig = getConfig();
  const parentDomain = snsConfig.snsParentDomain || "btcpro";

  // SNS registration state
  const [showSnsInput, setShowSnsInput] = useState(false);
  const [snsNameInput, setSnsNameInput] = useState("");

  const handleRegisterSnsName = async () => {
    if (!snsNameInput) return;
    const success = await registerSnsSubdomain(snsNameInput);
    if (success) {
      setShowSnsInput(false);
      setSnsNameInput("");
    }
  };

  const shortAddress = stealthAddressEncoded
    ? `${stealthAddressEncoded.slice(0, 16)}...${stealthAddressEncoded.slice(-16)}`
    : "";

  return (
    <main className="min-h-screen bg-background relative overflow-hidden">
      {/* Background effects */}
      <div className="hacker-bg fixed inset-0 pointer-events-none" />
      <div className="hacker-grid fixed inset-0 pointer-events-none opacity-30" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-screen p-4">
        {/* Header */}
        <div className="w-full max-w-[680px] mb-6 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Home
          </Link>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-btc/10 border border-btc/20 backdrop-blur-sm">
              <BitcoinIcon className="w-3.5 h-3.5" />
              <span className="text-caption text-btc font-semibold">BTC</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-privacy/10 border border-privacy/20 backdrop-blur-sm">
              <Shield className="w-3.5 h-3.5 text-privacy" />
              <span className="text-caption text-privacy font-semibold">ZK</span>
            </div>
          </div>
        </div>

        {/* Dashboard Container — glassmorphism card */}
        <div
          className={cn(
            "backdrop-blur-xl bg-card/80 border border-gray/20",
            "w-[680px] max-w-[calc(100vw-32px)] rounded-[24px]",
            "shadow-[0_0_60px_rgba(20,241,149,0.04),0_0_120px_rgba(153,69,255,0.03)]",
            "p-8"
          )}
        >
          {/* Title Section */}
          <div className="text-center mb-8">
            <h1 className="text-[28px] font-bold text-foreground mb-2 tracking-tight">
              <span className="bg-gradient-to-r from-privacy/90 to-privacy bg-clip-text text-transparent">
                zVault
              </span>{" "}
              <span className="text-foreground">Bridge</span>
            </h1>
            <p className="text-body2 text-gray">
              Bridge <span className="text-btc">Bitcoin</span> to <span className="text-purple">Solana</span> with <span className="text-privacy">zero-knowledge</span> privacy
            </p>
          </div>

          {/* Stealth Address Section */}
          <div className="mb-6 p-5 bg-muted/60 backdrop-blur-sm border border-privacy/15 rounded-[16px]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-[8px] bg-privacy/10">
                  <Key className="w-4 h-4 text-privacy" />
                </div>
                <h2 className="text-body1 text-foreground">
                  Your{" "}
                  <TooltipText
                    text="Stealth Address"
                    tooltip="A one-time address that hides your identity. Only you can scan and claim funds sent to it."
                  />
                </h2>
              </div>
              {keys && (
                <button
                  onClick={() => clearKeys(wallet.publicKey?.toBase58())}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-caption text-gray hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                  title="Clear keys and log out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Log out
                </button>
              )}
            </div>

            {!wallet.connected ? (
              <div className="text-center py-5">
                <p className="text-body2 text-gray mb-4">
                  Connect your wallet to generate a private stealth address
                </p>
                <button
                  onClick={() => setVisible(true)}
                  className={cn(
                    "inline-flex items-center gap-2 px-5 py-2.5 rounded-[12px]",
                    "bg-privacy/20 hover:bg-privacy/30 border border-privacy/30",
                    "text-body2 text-privacy transition-all duration-200 cursor-pointer",
                    "hover:shadow-[0_0_20px_rgba(20,241,149,0.15)]"
                  )}
                >
                  <Wallet className="w-4 h-4" />
                  Connect Wallet
                </button>
              </div>
            ) : !keys ? (
              <div className="text-center py-5">
                <p className="text-body2 text-gray mb-4">
                  Sign a message to derive your private zVault keys
                </p>
                {error && (
                  <p className="text-caption text-red-400 mb-3">{error}</p>
                )}
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={deriveKeys}
                    disabled={isLoading}
                    className={cn(
                      "inline-flex items-center gap-2 px-5 py-2.5 rounded-[12px]",
                      "bg-privacy hover:bg-privacy/80 disabled:bg-gray/30",
                      "text-body2 text-background disabled:text-gray transition-all duration-200 cursor-pointer",
                      "hover:shadow-[0_0_20px_rgba(20,241,149,0.2)]"
                    )}
                  >
                    <Key className="w-4 h-4" />
                    {isLoading ? "Signing..." : "Sign to Derive Keys"}
                  </button>
                  <button
                    onClick={() => wallet.disconnect().catch(() => {})}
                    className={cn(
                      "inline-flex items-center gap-2 px-4 py-2.5 rounded-[12px]",
                      "bg-gray/20 hover:bg-red-500/20 border border-gray/30 hover:border-red-500/30",
                      "text-body2 text-gray hover:text-red-400 transition-colors cursor-pointer"
                    )}
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {/* SNS name badge */}
                {registeredSnsName && (
                  <div className="mb-3">
                    <div className="flex items-center gap-2 p-3 bg-btc/10 border border-btc/30 rounded-[10px]">
                      <Globe className="w-4 h-4 text-btc" />
                      <span className="text-body2-semibold text-btc">
                        {registeredSnsName}.{parentDomain}.sol
                      </span>
                      <button
                        onClick={() => { copySns(`${registeredSnsName}.${parentDomain}.sol`); notifyCopied(`.${parentDomain}.sol name`); }}
                        className="ml-auto p-1.5 rounded-[6px] bg-btc/10 hover:bg-btc/20 transition-colors cursor-pointer"
                        title={`Copy .${parentDomain}.sol name`}
                      >
                        {snsCopied ? (
                          <Check className="w-3 h-3 text-green-400" />
                        ) : (
                          <Copy className="w-3 h-3 text-btc" />
                        )}
                      </button>
                    </div>
                    {snsNeedsUpdate && (
                      <button
                        onClick={updateSnsStealthData}
                        disabled={isRegisteringSns}
                        className={cn(
                          "w-full flex items-center justify-center gap-2 mt-2 px-3 py-2 rounded-[8px]",
                          "bg-yellow-500/10 border border-yellow-500/30 hover:bg-yellow-500/20",
                          "text-caption text-yellow-400 transition-colors cursor-pointer",
                          "disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                      >
                        {isRegisteringSns ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Updating...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-3 h-3" />
                            Update SNS record (outdated format)
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}

                {/* Stealth address */}
                <div className="flex items-center gap-2 p-3 bg-background/50 rounded-[10px] mb-2">
                  <code className="flex-1 text-caption font-mono text-privacy truncate">
                    {shortAddress}
                  </code>
                  <button
                    onClick={() => { copyStealth(stealthAddressEncoded || ""); notifyCopied("Stealth address"); }}
                    className={cn(
                      "p-2 rounded-[6px] transition-colors cursor-pointer",
                      "bg-privacy/10 hover:bg-privacy/20"
                    )}
                    title="Copy stealth address"
                  >
                    {stealthCopied ? (
                      <Check className="w-4 h-4 text-green-400" />
                    ) : (
                      <Copy className="w-4 h-4 text-privacy" />
                    )}
                  </button>
                </div>

                {/* SNS name registration */}
                {!registeredSnsName && !showSnsInput && !isLoadingSnsName && keys && (
                  <button
                    onClick={() => setShowSnsInput(true)}
                    className="flex items-center gap-2 text-caption text-btc hover:text-btc/80 transition-colors mt-2 cursor-pointer"
                  >
                    <Globe className="w-3 h-3" />
                    Register a .{parentDomain}.sol name
                  </button>
                )}
                {isLoadingSnsName && (
                  <div className="flex items-center gap-2 text-caption text-gray mt-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Checking for .{parentDomain}.sol name...
                  </div>
                )}

                {showSnsInput && (
                  <div className="mt-3 p-3 bg-background/50 rounded-[10px] border border-btc/20">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex-1 relative">
                        <input
                          type="text"
                          value={snsNameInput}
                          onChange={(e) => setSnsNameInput(e.target.value.toLowerCase())}
                          placeholder="yourname"
                          className={cn(
                            "w-full px-3 py-2 bg-muted border rounded-[8px]",
                            "text-body2 text-foreground placeholder:text-gray",
                            "outline-none transition-colors",
                            "border-gray/30 focus:border-btc/50"
                          )}
                        />
                      </div>
                      <span className="text-body2 text-gray">.{parentDomain}.sol</span>
                    </div>
                    {snsError && (
                      <p className="text-caption text-red-400 mb-2">{snsError}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={handleRegisterSnsName}
                        disabled={isRegisteringSns || !snsNameInput}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[8px]",
                          "bg-btc hover:bg-btc/80 text-background",
                          "disabled:bg-gray/30 disabled:text-gray disabled:cursor-not-allowed",
                          "transition-colors text-caption cursor-pointer"
                        )}
                      >
                        {isRegisteringSns ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Registering...
                          </>
                        ) : (
                          <>
                            <Globe className="w-3 h-3" />
                            Register
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setShowSnsInput(false);
                          setSnsNameInput("");
                        }}
                        className="px-3 py-2 rounded-[8px] bg-gray/20 hover:bg-gray/30 text-gray-light text-caption transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-caption text-gray mt-2">
                  Share this address to receive private payments. Only you can claim funds sent here.
                </p>
              </div>
            )}
          </div>

          {/* Claimable Notes Summary — gradient accent */}
          {keys && (
            <div className={cn(
              "mb-6 p-5 rounded-[16px] relative overflow-hidden",
              "bg-gradient-to-r from-privacy/5 via-muted/80 to-purple/5",
              "border border-privacy/20"
            )}>
              <div className="flex items-center justify-between relative z-10">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-[10px] bg-privacy/10 border border-privacy/20">
                    <Wallet className="w-5 h-5 text-privacy" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-caption text-gray">Claimable Notes</p>
                      <button
                        onClick={refreshInbox}
                        disabled={isLoadingInbox}
                        className="p-1 rounded-[4px] text-gray hover:text-privacy hover:bg-privacy/10 transition-colors disabled:opacity-50 cursor-pointer"
                        title="Refresh notes"
                      >
                        <RefreshCw className={cn("w-3 h-3", isLoadingInbox && "animate-spin")} />
                      </button>
                    </div>
                    <div className="flex items-baseline gap-2">
                      {isLoadingInbox ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-privacy" />
                          <span className="text-body2 text-gray">Scanning...</span>
                        </div>
                      ) : (
                        <>
                          <span className="text-[22px] font-bold text-privacy font-mono tracking-tight">
                            {(Number(totalAmountSats) / 100_000_000).toFixed(8)}
                          </span>
                          <span className="text-body2 text-gray">zBTC</span>
                          {depositCount > 0 && (
                            <span className="text-caption text-gray/60 ml-1">
                              ({depositCount} note{depositCount !== 1 ? "s" : ""})
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                {depositCount > 0 && (
                  <Link
                    href="/bridge/activity?tab=notes"
                    className={cn(
                      "flex items-center gap-1.5 px-4 py-2 rounded-[10px]",
                      "bg-privacy/10 hover:bg-privacy/20 border border-privacy/20",
                      "text-privacy text-body2 transition-all duration-200 cursor-pointer",
                      "hover:shadow-[0_0_15px_rgba(20,241,149,0.1)]"
                    )}
                  >
                    View Notes
                    <Wallet className="w-4 h-4" />
                  </Link>
                )}
              </div>
            </div>
          )}

          {/* Divider with label */}
          <div className="flex items-center gap-3 mb-5">
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
            <span className="text-caption text-gray/50 uppercase tracking-widest">Actions</span>
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
          </div>

          {/* Feature Cards Grid - 2x2 */}
          <div className="grid grid-cols-2 gap-4 mb-8">
            {features.map((feature) => (
              <FeatureCard
                key={feature.title}
                icon={feature.icon}
                title={feature.title}
                description={feature.description}
                subtext={feature.subtext}
                href={feature.href}
                color={feature.color}
                disabled={feature.disabled}
                badge={feature.badge}
              />
            ))}
          </div>

          {/* Info Section */}
          <div className="p-4 bg-privacy/5 border border-privacy/10 rounded-[12px] mb-5">
            <div className="flex items-start gap-3">
              <Shield className="w-5 h-5 text-privacy shrink-0 mt-0.5" />
              <div>
                <p className="text-body2-semibold text-privacy mb-1">
                  Privacy Preserving Bridge
                </p>
                <p className="text-caption text-gray">
                  Your deposits and withdrawals are protected by zero-knowledge proofs.
                  No one can link your Bitcoin deposits to zBTC claims.
                </p>
              </div>
            </div>
          </div>

          {/* Network Status */}
          <div className="flex items-center gap-2 py-2.5 px-4 bg-warning/5 border border-warning/15 rounded-[10px]">
            <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
            <span className="text-caption text-warning">
              Bitcoin {getConfig().bitcoinNetwork.charAt(0).toUpperCase() + getConfig().bitcoinNetwork.slice(1)} + Solana {getConfig().network.charAt(0).toUpperCase() + getConfig().network.slice(1)}
            </span>
          </div>

          {/* Footer */}
          <div className="flex flex-row justify-between items-center gap-2 mt-6 text-gray pt-4 border-t border-gray/10">
            <div className="flex flex-row items-center gap-4">
              <a
                href="https://zVault.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-gray-light transition-colors text-caption cursor-pointer"
              >
                zVault
                <ExternalLink className="w-3 h-3 opacity-50" />
              </a>
              <a
                href="https://github.com/cheng-chun-yuan/zVault"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-gray-light transition-colors text-caption cursor-pointer"
              >
                GitHub
                <ExternalLink className="w-3 h-3 opacity-50" />
              </a>
              <a
                href="https://docs.zVault.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-gray-light transition-colors text-caption cursor-pointer"
              >
                Docs
                <ExternalLink className="w-3 h-3 opacity-50" />
              </a>
            </div>
            <a href="https://zeusnetwork.xyz/" target="_blank" rel="noopener noreferrer" className="text-caption text-gray/50 hover:text-gray-light transition-colors">Powered by Zeus Network</a>
          </div>
        </div>
      </div>

      {/* First-time user onboarding */}
      <OnboardingModal />
    </main>
  );
}
