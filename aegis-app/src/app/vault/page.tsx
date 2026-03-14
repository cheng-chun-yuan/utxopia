"use client";

import { useState, Fragment } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
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
  Globe,
  RefreshCw,
  Eye,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FeatureCard, type FeatureCardColor } from "@/components/ui/feature-card";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useAegisKeys } from "@/hooks/use-aegis";
import { usePasskey } from "@/hooks/use-passkey";
import { useAegisStore } from "@/stores";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useSnsName } from "@/hooks/use-sns-name";
import { useStealthInbox } from "@/hooks/use-aegis";
import { getConfig, exportViewOnlyKeys, encodeViewOnlyKeys } from "@aegis/sdk";
import { notifyCopied } from "@/lib/notifications";
import { OnboardingModal } from "@/components/onboarding-modal";
import { AuthModal } from "@/components/auth-modal";
import { HoldButton } from "@/components/ui/hold-button";
import { FloatingOrbs } from "@/components/ui/floating-orbs";
import { MouseSpotlight } from "@/components/ui/mouse-spotlight";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

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
    subtext: "Bridge & shield",
    href: "/vault/deposit",
    color: "btc",
  },
  {
    icon: <Send className="w-full h-full" />,
    title: "Transfer",
    description: "Send zkBTC",
    subtext: "Private payments",
    href: "/vault/pay",
    color: "privacy",
  },
  {
    icon: <Wallet className="w-full h-full" />,
    title: "Portfolio",
    description: "Your notes",
    subtext: "View & spend",
    href: "/vault/activity",
    color: "privacy",
  },
  {
    icon: <Search className="w-full h-full" />,
    title: "Explorer",
    description: "On-chain data",
    subtext: "Txns & proofs",
    href: "/explorer",
    color: "purple",
  },
];

export default function VaultPage() {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const {
    keys,
    isViewOnly,
    stealthAddressEncoded,
    isLoading,
    error,
    deriveKeys,
    clearKeys,
  } = useAegisKeys();
  const { copied: snsCopied, copy: copySns } = useCopyToClipboard();
  const { copied: stealthCopied, copy: copyStealth } = useCopyToClipboard();
  const { copied: viewKeyCopied, copy: copyViewKey } = useCopyToClipboard();
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

  const {
    isSupported: passkeySupported,
    hasCredential: hasPasskeyCredential,
    isLoading: passkeyLoading,
    error: passkeyError,
    register: registerPasskey,
    authenticate: authenticatePasskey,
    clearCredential: clearPasskeyCredential,
  } = usePasskey();

  const deriveKeysFromPasskeySeed = useAegisStore((s) => s.deriveKeysFromPasskeySeed);
  const loadViewOnlyKeys = useAegisStore((s) => s.loadViewOnlyKeys);

  const handlePasskeyRegister = async () => {
    const seed = await registerPasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  const handlePasskeyAuthenticate = async () => {
    const seed = await authenticatePasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [viewKeyModalOpen, setViewKeyModalOpen] = useState(false);

  const isPasskeyUser = keys && keys.solanaPublicKey.every(b => b === 0);

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
    <main className="min-h-screen bg-background hacker-bg noise-overlay relative overflow-hidden">
      <MouseSpotlight />
      <SiteHeader />
      {/* Background effects */}
      <div className="hacker-grid fixed inset-0 pointer-events-none opacity-30 animate-grid-drift" />
      <FloatingOrbs className="fixed" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center min-h-screen pt-24 pb-8 px-4">

        {/* Dashboard Container — glassmorphism card */}
        <motion.div
          className={cn(
            "glass-card-strong",
            "w-[680px] max-w-[calc(100vw-32px)] rounded-[24px]",
            "p-4 sm:p-8"
          )}
          initial={{ opacity: 0, y: 20, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Title Section — web3 dashboard style */}
          <div className="flex items-center justify-between mb-6 sm:mb-8">
            <div>
              <h1 className="text-[20px] sm:text-[24px] font-bold text-foreground tracking-tight">
                Vault
              </h1>
              <p className="text-caption text-gray">
                Deposit, transfer &amp; withdraw private BTC
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-btc/10 border border-btc/20 backdrop-blur-sm">
                <BitcoinIcon className="w-3 h-3" />
                <span className="text-[10px] text-btc font-semibold">BTC</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-privacy/10 border border-privacy/20 backdrop-blur-sm">
                <Shield className="w-3 h-3 text-privacy" />
                <span className="text-[10px] text-privacy font-semibold">ZK</span>
              </div>
            </div>
          </div>

          {/* Stealth Address Section */}
          <div className="mb-6 p-5 bg-muted/60 backdrop-blur-sm border border-privacy/15 rounded-[16px]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-[8px] bg-privacy/10">
                  {isViewOnly ? <Eye className="w-4 h-4 text-btc" /> : <Key className="w-4 h-4 text-privacy" />}
                </div>
                <h2 className="text-body1 text-foreground">
                  {isViewOnly ? "View Only Mode" : "Your Stealth Address"}
                </h2>
                {isViewOnly && (
                  <span className="px-2 py-0.5 rounded-full bg-btc/10 border border-btc/20 text-[10px] text-btc font-semibold uppercase">
                    Read Only
                  </span>
                )}
              </div>
              {(keys || isViewOnly) && (
                <button
                  onClick={() => {
                    clearKeys(wallet.publicKey?.toBase58());
                  }}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-caption text-gray hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                  title="Clear keys and log out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Log out
                </button>
              )}
            </div>

            {!keys && !isViewOnly ? (
              <div className="text-center py-6">
                <div className="w-14 h-14 rounded-2xl bg-privacy/10 border border-privacy/20 flex items-center justify-center mx-auto mb-4">
                  <Key className="w-6 h-6 text-privacy" />
                </div>
                <p className="text-body2 text-foreground mb-1">
                  Connect to Start
                </p>
                <p className="text-caption text-gray/60 mb-5">
                  Use a passkey or Solana wallet to derive your private keys
                </p>
                <button
                  onClick={() => setAuthModalOpen(true)}
                  className={cn(
                    "inline-flex items-center gap-2 px-7 py-3 rounded-full",
                    "bg-privacy hover:bg-privacy/80",
                    "text-body2 text-background font-semibold transition-all duration-200 cursor-pointer",
                    "hover:shadow-[0_0_24px_rgba(20,241,149,0.25)]",
                    "active:scale-95"
                  )}
                >
                  <Key className="w-4 h-4" />
                  Connect &amp; Unlock
                </button>
              </div>
            ) : isViewOnly ? (
              <p className="text-caption text-btc">
                Watching balances with viewing key. Cannot send or spend.
              </p>
            ) : (
              <div>
                {/* Address bar — shows SNS name (green) if available, stealth address otherwise */}
                {!isPasskeyUser && hasRegisteredSnsName ? (
                  <div className="mb-2">
                    <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/25 rounded-[10px]">
                      <Globe className="w-4 h-4 text-green-400 shrink-0" />
                      <span className="flex-1 text-body2-semibold text-green-400 truncate">
                        {registeredSnsName}.{parentDomain}.sol
                      </span>
                      <button
                        onClick={() => { copySns(`${registeredSnsName}.${parentDomain}.sol`); notifyCopied(`.${parentDomain}.sol name`); }}
                        className="p-2 rounded-[6px] bg-green-500/10 hover:bg-green-500/20 transition-colors cursor-pointer"
                        title={`Copy .${parentDomain}.sol name`}
                      >
                        {snsCopied ? (
                          <Check className="w-4 h-4 text-green-400" />
                        ) : (
                          <Copy className="w-4 h-4 text-green-400" />
                        )}
                      </button>
                    </div>
                    <button
                      onClick={() => { copyStealth(stealthAddressEncoded || ""); notifyCopied("Stealth address"); }}
                      className="flex items-center gap-1.5 mt-1.5 px-1 group cursor-pointer"
                      title="Copy stealth address"
                    >
                      <code className="text-[11px] font-mono text-gray/50 truncate group-hover:text-gray/70 transition-colors">
                        {shortAddress}
                      </code>
                      <Copy className="w-3 h-3 text-gray/30 group-hover:text-gray/50 transition-colors shrink-0" />
                    </button>
                  </div>
                ) : (
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
                )}

                {/* SNS needs update warning */}
                {!isPasskeyUser && snsNeedsUpdate && (
                  <button
                    onClick={updateSnsStealthData}
                    disabled={isRegisteringSns}
                    className={cn(
                      "w-full flex items-center justify-center gap-2 mb-2 px-3 py-2 rounded-[8px]",
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

                {/* SNS name registration */}
                {!isPasskeyUser && !registeredSnsName && !showSnsInput && !isLoadingSnsName && keys && (
                  <button
                    onClick={() => setShowSnsInput(true)}
                    className="flex items-center gap-2 text-caption text-btc hover:text-btc/80 transition-colors mt-2 cursor-pointer"
                  >
                    <Globe className="w-3 h-3" />
                    Register a .{parentDomain}.sol name
                  </button>
                )}
                {!isPasskeyUser && isLoadingSnsName && (
                  <div className="flex items-center gap-2 text-caption text-gray mt-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Checking for .{parentDomain}.sol name...
                  </div>
                )}

                {!isPasskeyUser && showSnsInput && (
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

                <div className="flex items-center justify-between mt-2">
                  <p className="text-caption text-gray">
                    Share this address to receive private payments.
                  </p>
                  {keys && (
                    <button
                      onClick={() => setViewKeyModalOpen(true)}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-caption text-btc/70 hover:text-btc hover:bg-btc/10 transition-colors cursor-pointer shrink-0"
                      title="Export viewing key"
                    >
                      <Eye className="w-3 h-3" />
                      Export Viewing Key
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Claimable Notes Summary — gradient accent */}
          {(keys || isViewOnly) && (
            <div className={cn(
              "mb-6 p-5 rounded-[16px] relative overflow-hidden",
              "bg-gradient-to-r from-privacy/5 via-muted/80 to-purple/5",
              "border border-privacy/20"
            )}>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 relative z-10">
                <div className="flex items-center gap-3">
                  <div className="p-2 sm:p-2.5 rounded-[10px] bg-privacy/10 border border-privacy/20 shrink-0">
                    <Wallet className="w-4 h-4 sm:w-5 sm:h-5 text-privacy" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-caption text-gray">Ready to Spend</p>
                      <button
                        onClick={refreshInbox}
                        disabled={isLoadingInbox}
                        className="p-1 rounded-[4px] text-gray hover:text-privacy hover:bg-privacy/10 transition-colors disabled:opacity-50 cursor-pointer"
                        title="Refresh notes"
                      >
                        <RefreshCw className={cn("w-3 h-3", isLoadingInbox && "animate-spin")} />
                      </button>
                    </div>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      {isLoadingInbox ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-privacy" />
                          <span className="text-body2 text-gray">Scanning...</span>
                        </div>
                      ) : (
                        <>
                          <span className="text-[18px] sm:text-[22px] font-bold text-privacy font-mono tracking-tight">
                            {(Number(totalAmountSats) / 100_000_000).toFixed(8)}
                          </span>
                          <span className="text-caption sm:text-body2 text-gray">zkBTC</span>
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
                    href="/vault/activity?tab=notes"
                    className={cn(
                      "flex items-center justify-center gap-1.5 px-4 py-2 rounded-[10px]",
                      "bg-privacy/10 hover:bg-privacy/20 border border-privacy/20",
                      "text-privacy text-body2 transition-all duration-200 cursor-pointer",
                      "hover:shadow-[0_0_15px_rgba(20,241,149,0.1)]",
                      "shrink-0"
                    )}
                  >
                    View Funds
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
          <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-6 sm:mb-8">
            {features
              .filter((f) => !isViewOnly || f.title === "My Funds" || f.title === "Explorer")
              .map((feature) => (
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

          {/* Quick guide for web3 users */}
          <div className="p-4 bg-muted/40 border border-gray/10 rounded-[12px] mb-5 space-y-2.5">
            <p className="text-caption font-semibold text-foreground flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-privacy" />
              How Private Bitcoin Works
            </p>
            <div className="space-y-2">
              {[
                { step: "1", label: "Deposit BTC", sub: "Send to Taproot address" },
                { step: "2", label: "Get zkBTC", sub: "Shielded via ZK proof" },
                { step: "3", label: "Use Privately", sub: "Transfer or withdraw" },
              ].map((s, i) => (
                <div key={s.step} className="flex items-center gap-3">
                  <span className="text-lg font-bold font-mono text-privacy/50 w-6 shrink-0">{s.step}</span>
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <span className="text-[12px] font-medium text-foreground">{s.label}</span>
                    <span className="text-[10px] text-gray/40">—</span>
                    <span className="text-[10px] text-gray/50">{s.sub}</span>
                  </div>
                  {i < 2 && <ChevronRight className="w-3 h-3 text-gray/20 shrink-0" />}
                </div>
              ))}
            </div>
          </div>

          {/* Network Status */}
          <div className="flex items-center gap-2 py-2.5 px-4 bg-warning/5 border border-warning/15 rounded-[10px]">
            <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
            <span className="text-caption text-warning">
              Bitcoin {getConfig().bitcoinNetwork.charAt(0).toUpperCase() + getConfig().bitcoinNetwork.slice(1)} + Solana {getConfig().network.charAt(0).toUpperCase() + getConfig().network.slice(1)}
            </span>
          </div>

        </motion.div>
      </div>
      <SiteFooter />

      {/* First-time user onboarding */}
      <OnboardingModal />

      {/* Auth modal */}
      <AuthModal
        open={authModalOpen}
        onOpenChange={setAuthModalOpen}
        passkeySupported={passkeySupported}
        hasPasskeyCredential={hasPasskeyCredential}
        passkeyLoading={passkeyLoading}
        walletLoading={isLoading}
        walletConnected={wallet.connected}
        error={error || passkeyError}
        onPasskeyRegister={handlePasskeyRegister}
        onPasskeyAuthenticate={handlePasskeyAuthenticate}
        onWalletConnect={() => { setAuthModalOpen(false); setVisible(true); }}
        onWalletDeriveKeys={async () => { await deriveKeys(); setAuthModalOpen(false); }}
        onViewOnlyLogin={(viewingKey) => { loadViewOnlyKeys(viewingKey); setAuthModalOpen(false); }}
      />

      {/* Export Viewing Key modal */}
      {viewKeyModalOpen && keys && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-md"
            onClick={() => setViewKeyModalOpen(false)}
          />
          <div className={cn(
            "relative w-[90vw] max-w-[380px] rounded-[20px] p-6",
            "bg-card/95 backdrop-blur-xl border border-gray/20",
            "shadow-[0_0_80px_rgba(245,158,11,0.06)]",
            "animate-in fade-in-0 zoom-in-95 duration-200"
          )}>
            <div className="text-center mb-5">
              <div className="inline-flex p-3 rounded-full bg-btc/10 border border-btc/20 mb-3">
                <Eye className="w-5 h-5 text-btc" />
              </div>
              <h3 className="text-body1 font-bold text-foreground mb-1">Export Viewing Key</h3>
              <p className="text-caption text-gray">
                This key grants read-only access to your balances and transaction history. Do not share it publicly.
              </p>
            </div>

            <HoldButton
              onComplete={() => {
                const voKeys = exportViewOnlyKeys(keys);
                const encoded = encodeViewOnlyKeys(voKeys);
                copyViewKey(encoded);
                notifyCopied("Viewing key");
                setViewKeyModalOpen(false);
              }}
              holdDuration={1500}
              className={cn(
                "w-full flex items-center justify-center gap-2 px-4 py-3 rounded-[12px]",
                "bg-btc/10 hover:bg-btc/20 border border-btc/20",
                "text-body2 text-btc font-medium transition-all cursor-pointer"
              )}
              progressClassName="bg-btc"
              title="Hold to copy viewing key"
            >
              {viewKeyCopied ? <Check className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {viewKeyCopied ? "Copied!" : "Hold to Copy"}
            </HoldButton>

            <button
              onClick={() => setViewKeyModalOpen(false)}
              className="w-full mt-3 px-4 py-2 rounded-[10px] text-caption text-gray hover:text-gray-light hover:bg-gray/10 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
