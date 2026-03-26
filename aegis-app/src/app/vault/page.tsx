"use client";

/**
 * VaultPage — main dashboard for the private Bitcoin vault.
 *
 * Sections:
 * - Stealth Address: displays user's stealth address or prompts to connect
 * - SNS Name: register/update .btcpro.sol human-readable stealth address
 * - Claimable Notes: shows total spendable zkBTC balance from stealth inbox
 * - Feature Cards: quick links to Deposit, Transfer, Portfolio, Explorer
 * - Quick Guide: 3-step overview of how Private Bitcoin works
 * - Auth Modal: passkey registration/login or wallet connection
 * - Viewing Key Export: hold-to-copy modal for read-only key sharing
 *
 * Authentication supports:
 * - WebAuthn passkeys (PRF-derived deterministic keys)
 * - Solana wallet (signature-derived keys)
 * - View-only mode (viewing key import)
 */

import { useState, Fragment } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowLeft,
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
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
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
import { useTokenPrices } from "@/hooks/use-btc-price";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import { OnboardingModal } from "@/components/onboarding-modal";
import { AuthModal } from "@/components/auth-modal";
import { HoldButton } from "@/components/ui/hold-button";

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
    balancesByToken,
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

  const tokenPrices = useTokenPrices();
  const btcPrice = tokenPrices.btc;

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

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col">
      <SiteHeader />

      <div className="flex-1 flex flex-col items-center pt-24 pb-8 px-4">
      <motion.div
        className={cn(
          "bg-card border border-solid border-gray/30 p-4 sm:p-8",
          "w-[680px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10"
        )}
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
          {/* Wallet Header — identity bar */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 min-w-0">
              {(keys || isViewOnly) ? (
                <>
                  {/* Identity chip */}
                  {!isPasskeyUser && hasRegisteredSnsName ? (
                    <button
                      onClick={() => { copySns(`${registeredSnsName}.${parentDomain}.sol`); notifyCopied(`.${parentDomain}.sol name`); }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-green-500/10 hover:bg-green-500/15 transition-colors group cursor-pointer min-w-0"
                      title={`Copy .${parentDomain}.sol name`}
                    >
                      <Globe className="w-3.5 h-3.5 text-green-400 shrink-0" />
                      <span className="text-body2-semibold text-green-400 truncate">
                        {registeredSnsName}.{parentDomain}.sol
                      </span>
                      {snsCopied ? (
                        <Check className="w-3 h-3 text-green-400 shrink-0" />
                      ) : (
                        <Copy className="w-3 h-3 text-green-400/40 group-hover:text-green-400 transition-colors shrink-0" />
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={() => { copyStealth(stealthAddressEncoded || ""); notifyCopied("Stealth address"); }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-privacy/10 hover:bg-privacy/15 transition-colors group cursor-pointer min-w-0"
                      title="Copy stealth address"
                    >
                      <Key className="w-3.5 h-3.5 text-privacy shrink-0" />
                      <code className="text-[12px] font-mono text-privacy truncate">
                        {stealthAddressEncoded ? `${stealthAddressEncoded.slice(0, 8)}...${stealthAddressEncoded.slice(-6)}` : ""}
                      </code>
                      {stealthCopied ? (
                        <Check className="w-3 h-3 text-green-400 shrink-0" />
                      ) : (
                        <Copy className="w-3 h-3 text-privacy/40 group-hover:text-privacy transition-colors shrink-0" />
                      )}
                    </button>
                  )}
                  {isViewOnly && (
                    <span className="px-2 py-0.5 rounded-full bg-btc/10 border border-btc/20 text-[10px] text-btc font-semibold uppercase shrink-0">
                      View Only
                    </span>
                  )}
                </>
              ) : (
                <span className="text-body2-semibold text-foreground">Wallet</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {keys && (
                <button
                  onClick={() => setViewKeyModalOpen(true)}
                  className="p-1.5 rounded-[8px] text-gray/50 hover:text-btc hover:bg-btc/10 transition-colors cursor-pointer"
                  title="Export viewing key"
                >
                  <Eye className="w-4 h-4" />
                </button>
              )}
              {(keys || isViewOnly) && (
                <button
                  onClick={() => clearKeys(wallet.publicKey?.toBase58())}
                  className="p-1.5 rounded-[8px] text-gray/50 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                  title="Log out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Secondary identity line — stealth address when SNS is primary + action links */}
          {(keys && !isViewOnly) && (
            <div className="flex items-center gap-3 mb-4 px-1">
              {!isPasskeyUser && hasRegisteredSnsName && (
                <button
                  onClick={() => { copyStealth(stealthAddressEncoded || ""); notifyCopied("Stealth address"); }}
                  className="flex items-center gap-1 group cursor-pointer"
                  title="Copy stealth address"
                >
                  <code className="text-[11px] font-mono text-gray/35 group-hover:text-gray/55 transition-colors">
                    {stealthAddressEncoded ? `${stealthAddressEncoded.slice(0, 10)}...${stealthAddressEncoded.slice(-8)}` : ""}
                  </code>
                  <Copy className="w-2.5 h-2.5 text-gray/25 group-hover:text-gray/45 transition-colors shrink-0" />
                </button>
              )}
              {!isPasskeyUser && !registeredSnsName && !showSnsInput && !isLoadingSnsName && keys && (
                <button
                  onClick={() => setShowSnsInput(true)}
                  className="flex items-center gap-1 text-[11px] text-btc/50 hover:text-btc transition-colors cursor-pointer"
                >
                  <Globe className="w-3 h-3" />
                  Register .{parentDomain}.sol
                </button>
              )}
              {!isPasskeyUser && isLoadingSnsName && (
                <span className="flex items-center gap-1 text-[11px] text-gray/35">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Checking name...
                </span>
              )}
            </div>
          )}

          {/* SNS needs update warning */}
          {keys && !isPasskeyUser && snsNeedsUpdate && (
            <button
              onClick={updateSnsStealthData}
              disabled={isRegisteringSns}
              className={cn(
                "w-full flex items-center justify-center gap-2 mb-4 px-3 py-1.5 rounded-[8px]",
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
                  Update SNS record
                </>
              )}
            </button>
          )}

          {/* SNS registration input (toggled) */}
          {keys && !isPasskeyUser && showSnsInput && (
            <div className="mb-4 p-3 bg-background/50 rounded-[10px] border border-btc/20">
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

          {/* ═══ Hero Balance ═══ */}
          {!keys && !isViewOnly ? (
            /* Not connected — centered CTA */
            <div className="flex flex-col items-center py-10">
              <div className="w-16 h-16 rounded-2xl bg-privacy/10 border border-privacy/20 flex items-center justify-center mb-4">
                <Shield className="w-7 h-7 text-privacy" />
              </div>
              <h1 className="text-[22px] font-bold text-foreground mb-1">Private Wallet</h1>
              <p className="text-caption text-gray/60 mb-6">
                Shield, transfer &amp; unshield tokens with ZK proofs
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
          ) : (
            <>
              {/* Big balance display — USD hero, BTC secondary */}
              <div className="text-center py-6 mb-2">
                {isLoadingInbox ? (
                  <Loader2 className="w-6 h-6 animate-spin text-privacy mx-auto mb-2" />
                ) : (
                  <>
                    {(() => {
                      // Calculate total USD from all token balances
                      let totalUsd = 0;
                      for (const token of VAULT_TOKENS) {
                        const rawBal = Number(balancesByToken?.[token.shieldedSymbol] ?? 0n);
                        const price = tokenPrices[token.priceKey];
                        if (price) totalUsd += (rawBal / 10 ** token.decimals) * price;
                      }
                      const btcPrice = tokenPrices["btc"] || 0;
                      const btcEquivalent = btcPrice > 0 ? totalUsd / btcPrice : 0;
                      return (
                        <>
                          <motion.p
                            className="text-[36px] sm:text-[42px] font-bold text-foreground tracking-tight leading-none mb-1"
                            key={totalUsd.toFixed(2)}
                            initial={{ opacity: 0.6, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.35, ease: "easeOut" }}
                          >
                            ${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </motion.p>
                          <p className="text-body2 text-gray/60 font-mono flex items-center justify-center gap-1.5">
                            {btcEquivalent.toFixed(8)} BTC
                            <button
                              onClick={refreshInbox}
                              disabled={isLoadingInbox}
                              className="p-0.5 rounded text-gray/30 hover:text-privacy transition-colors disabled:opacity-50 cursor-pointer"
                              title="Refresh"
                            >
                              <RefreshCw className={cn("w-3 h-3", isLoadingInbox && "animate-spin")} />
                            </button>
                          </p>
                        </>
                      );
                    })()}
                  </>
                )}
              </div>

              {/* ═══ Action Buttons — circular Phantom-style ═══ */}
              <div className="flex items-center justify-center gap-5 sm:gap-8 mb-6">
                {[
                  { icon: <ArrowDownToLine className="w-5 h-5" />, label: "Deposit", href: "/vault/deposit", color: "text-green-400" },
                  { icon: <Send className="w-5 h-5" />, label: "Send", href: "/vault/pay", color: "text-privacy" },
                  { icon: <Wallet className="w-5 h-5" />, label: "Activities", href: "/vault/activity", color: "text-privacy" },
                ].filter((a) => !isViewOnly || a.label === "Activities")
                  .map((action) => (
                  <Link
                    key={action.label}
                    href={action.href}
                    className="flex flex-col items-center gap-1.5 group cursor-pointer"
                  >
                    <motion.div
                      className={cn(
                        "w-12 h-12 rounded-full flex items-center justify-center",
                        "bg-muted/80 border border-gray/15",
                        "group-hover:border-privacy/30 group-hover:bg-privacy/10",
                        "transition-colors duration-200",
                        action.color
                      )}
                      whileHover={{ scale: 1.08, y: -2 }}
                      whileTap={{ scale: 0.92 }}
                      transition={{ type: "spring", stiffness: 400, damping: 17 }}
                    >
                      {action.icon}
                    </motion.div>
                    <span className="text-[11px] text-gray group-hover:text-foreground transition-colors">
                      {action.label}
                    </span>
                  </Link>
                ))}
              </div>

              {/* ═══ Token List ═══ */}
              <div className="mb-5">
                <div className="flex items-center justify-between px-1 mb-2">
                  <span className="text-[11px] text-gray/50 uppercase tracking-wider font-medium">Tokens</span>
                  {depositCount > 0 && (
                    <Link
                      href="/vault/activity?tab=notes"
                      className="flex items-center gap-0.5 text-[11px] text-privacy/60 hover:text-privacy transition-colors cursor-pointer"
                    >
                      View All
                      <ChevronRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>

                <div className="rounded-[14px] border border-gray/10 overflow-hidden divide-y divide-gray/8">
                  {(() => {
                    const hasAnyBalance = VAULT_TOKENS.some(
                      (token) => Number(balancesByToken?.[token.shieldedSymbol] ?? 0n) > 0
                    );

                    // When all balances are empty, show only zkBTC with a top-up prompt
                    if (!hasAnyBalance && !isLoadingInbox) {
                      const zkbtc = VAULT_TOKENS.find((t) => t.shieldedSymbol === "zkBTC");
                      return (
                        <div className="flex items-center gap-3 px-4 h-[60px]">
                          <motion.img
                            src={zkbtc?.shieldedLogo || "/tokens/zkbtc.png"}
                            alt="zkBTC"
                            className="w-9 h-9 rounded-full"
                            animate={{ y: [0, -2, 0] }}
                            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-body2-semibold text-foreground">zkBTC</p>
                            <p className="text-[11px] text-gray/50">Shielded Bitcoin</p>
                          </div>
                          <motion.div
                            animate={{
                              boxShadow: [
                                "0 0 0 rgba(20,241,149,0)",
                                "0 0 12px rgba(20,241,149,0.2)",
                                "0 0 0 rgba(20,241,149,0)",
                              ],
                            }}
                            transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
                            className="rounded-full"
                          >
                            <Link
                              href="/vault/deposit"
                              className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-privacy/10 hover:bg-privacy/20 border border-privacy/20 text-[11px] font-semibold text-privacy transition-colors cursor-pointer"
                            >
                              <ArrowDownToLine className="w-3 h-3" />
                              Top Up
                            </Link>
                          </motion.div>
                        </div>
                      );
                    }

                    // Sort tokens: those with balance first (by USD value desc), then zero-balance
                    const sorted = [...VAULT_TOKENS].sort((a, b) => {
                      const aRaw = Number(balancesByToken?.[a.shieldedSymbol] ?? 0n);
                      const bRaw = Number(balancesByToken?.[b.shieldedSymbol] ?? 0n);
                      if (aRaw > 0 && bRaw === 0) return -1;
                      if (aRaw === 0 && bRaw > 0) return 1;
                      const aUsd = (aRaw / 10 ** a.decimals) * (tokenPrices[a.priceKey] || 0);
                      const bUsd = (bRaw / 10 ** b.decimals) * (tokenPrices[b.priceKey] || 0);
                      return bUsd - aUsd;
                    });

                    return sorted.map((token) => {
                      const rawBalance = Number(balancesByToken?.[token.shieldedSymbol] ?? 0n);
                      const balanceNum = rawBalance / 10 ** token.decimals;
                      const hasBalance = rawBalance > 0;
                      const balance = balanceNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                      const price = tokenPrices[token.priceKey];
                      const usdValue = price ? (rawBalance / 10 ** token.decimals) * price : 0;
                      return (
                        <div key={token.symbol} className={cn("flex items-center gap-3 px-4 h-[60px] transition-colors", hasBalance ? "hover:bg-muted/40" : "opacity-40")}>
                          <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-9 h-9 rounded-full" />
                          <div className="flex-1 min-w-0">
                            <p className="text-body2-semibold text-foreground">{token.shieldedSymbol}</p>
                            <p className="text-[11px] text-gray/50">{token.name}</p>
                          </div>
                          <div className="text-right">
                            {isLoadingInbox ? (
                              <Loader2 className="w-4 h-4 animate-spin text-privacy ml-auto" />
                            ) : hasBalance ? (
                              <>
                                <p className="text-body2-semibold text-foreground font-mono">{balance}</p>
                                <p className="text-[11px] text-gray/45 font-mono">
                                  ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </p>
                              </>
                            ) : (
                              <p className="text-body2 text-gray/30 font-mono">0.00</p>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </>
          )}

          {/* How it works — compact */}
          <div className="px-3 py-3 bg-muted/30 rounded-[10px] mb-4">
            <div className="flex items-center gap-4">
              {[
                { step: "1", label: "Shield" },
                { step: "2", label: "Prove" },
                { step: "3", label: "Use" },
              ].map((s, i) => (
                <Fragment key={s.step}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold font-mono text-privacy/40">{s.step}</span>
                    <span className="text-[11px] text-gray/50">{s.label}</span>
                  </div>
                  {i < 2 && <ChevronRight className="w-3 h-3 text-gray/15 shrink-0" />}
                </Fragment>
              ))}
              <div className="flex-1" />
              <div className="flex items-center gap-1.5">
                <Shield className="w-3 h-3 text-privacy/40" />
                <span className="text-[10px] text-privacy/40 font-medium">ZK</span>
              </div>
            </div>
          </div>

          {/* Network Status */}
          <div className="flex items-center justify-center gap-2 py-2">
            <div className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
            <span className="text-[11px] text-gray/40">
              Bitcoin {getConfig().bitcoinNetwork.charAt(0).toUpperCase() + getConfig().bitcoinNetwork.slice(1)} · Solana {getConfig().network.charAt(0).toUpperCase() + getConfig().network.slice(1)}
            </span>
          </div>


        </motion.div>

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
      </div>
      <SiteFooter />
    </main>
  );
}
