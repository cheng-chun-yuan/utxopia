"use client";

import React, { memo } from "react";
import Link from "next/link";
import { Bitcoin, Shield, Zap, Lock, ExternalLink, ArrowRight, EyeOff, Fingerprint, ShieldCheck, Loader2 } from "lucide-react";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { usePoolStats, PoolStats } from "@/hooks/use-pool-stats";

const FeatureCard = memo(function FeatureCard({
  icon: Icon,
  title,
  description,
  variant = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  variant?: "default" | "bitcoin" | "privacy" | "cyber";
}) {
  const variantStyles = {
    default: {
      iconBg: "bg-purple/10",
      iconColor: "text-purple",
      cardClass: "gradient-bg-card",
    },
    bitcoin: {
      iconBg: "bg-btc/10",
      iconColor: "text-btc btc-glow",
      cardClass: "gradient-bg-bitcoin",
    },
    privacy: {
      iconBg: "bg-privacy/10",
      iconColor: "text-privacy privacy-glow",
      cardClass: "gradient-bg-card privacy-lines",
    },
    cyber: {
      iconBg: "bg-cyan/10",
      iconColor: "text-cyan",
      cardClass: "gradient-bg-cyber",
    },
  };

  const style = variantStyles[variant];

  return (
    <div className={`p-6 rounded-[16px] ${style.cardClass} space-y-3 text-left`}>
      <div className="flex justify-start">
        <div className={`p-3 rounded-[12px] ${style.iconBg}`}>
          <Icon className={`h-6 w-6 ${style.iconColor}`} />
        </div>
      </div>
      <h3 className="text-heading6 text-foreground">{title}</h3>
      <p className="text-body2 text-gray">{description}</p>
    </div>
  );
});

FeatureCard.displayName = "FeatureCard";

const StatsDisplay = memo(function StatsDisplay({
  stats,
  isLoading,
}: {
  stats: PoolStats | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-6 h-6 animate-spin text-gray" />
      </div>
    );
  }

  const vaultBtc = (Number(stats?.vaultBalance ?? 0n) / 100_000_000).toFixed(4);
  const deposits = (stats?.depositCount ?? 0).toLocaleString();
  const pending = (stats?.pendingRedemptions ?? 0).toLocaleString();

  return (
    <div className="grid grid-cols-3 gap-6">
      <div className="space-y-2 text-center">
        <div className="flex items-center justify-center gap-2">
          <Shield className="w-5 h-5 text-privacy privacy-glow" />
          <span className="text-heading5 text-privacy">{vaultBtc}</span>
        </div>
        <div className="text-caption text-gray">Vault (BTC)</div>
      </div>
      <div className="space-y-2 text-center">
        <div className="text-heading5 text-foreground">{deposits}</div>
        <div className="text-caption text-gray">Deposits</div>
      </div>
      <div className="space-y-2 text-center">
        <div className="text-heading5 text-foreground">{pending}</div>
        <div className="text-caption text-gray">Pending</div>
      </div>
    </div>
  );
});

StatsDisplay.displayName = "StatsDisplay";

export default function Home() {
  // Fetch real stats from on-chain pool state
  const { stats, isLoading } = usePoolStats();

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay">
      <div className="container mx-auto px-4 py-8 relative z-10">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-[12px] bg-gradient-to-br from-btc/20 to-privacy/20 border border-btc/20">
              <div className="relative">
                <BitcoinIcon className="h-6 w-6 btc-glow" />
                <Shield className="h-3 w-3 text-privacy absolute -bottom-1 -right-1" />
              </div>
            </div>
            <span className="text-heading6 text-foreground">zVault</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://docs.zVault.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body2 text-gray hover:text-gray-light transition-colors flex items-center gap-1"
            >
              Docs
              <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href="https://github.com/cheng-chun-yuan/zVault"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body2 text-gray hover:text-gray-light transition-colors flex items-center gap-1"
            >
              GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </header>

        {/* Main content */}
        <div className="flex flex-col gap-8 items-center max-w-4xl mx-auto">
          {/* Hero section */}
          <div className="text-center space-y-8 w-full">
            {/* Hero */}
            <div className="space-y-6">
              {/* Bitcoin + Privacy badge */}
              <div className="flex items-center justify-center gap-4">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-btc/10 border border-btc/20">
                  <BitcoinIcon className="w-4 h-4" />
                  <span className="text-caption text-btc">Bitcoin Native</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-privacy/10 border border-privacy/20">
                  <Shield className="w-4 h-4 text-privacy" />
                  <span className="text-caption text-privacy">ZK Privacy</span>
                </div>
              </div>

              {/* Main headline */}
              <h1 className="text-4xl lg:text-6xl font-bold text-foreground leading-tight">
                <span className="bg-gradient-to-r from-btc to-btc-light bg-clip-text text-transparent">
                  Bitcoin
                </span>{" "}
                Meets<br />
                <span className="bg-gradient-to-r from-privacy to-sol bg-clip-text text-transparent">
                  Zero-Knowledge Privacy
                </span>
              </h1>

              <p className="text-body1 text-gray-light max-w-xl mx-auto">
                Bridge your BTC to Solana with complete privacy. Zero-knowledge proofs ensure
                your transactions remain confidential while maintaining full Bitcoin backing.
              </p>

              {/* Privacy features inline */}
              <div className="flex flex-wrap items-center justify-center gap-4 text-caption text-gray">
                <div className="flex items-center gap-1.5">
                  <EyeOff className="w-4 h-4 text-privacy" />
                  <span>Hidden Amounts</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Fingerprint className="w-4 h-4 text-sol" />
                  <span>Anonymous Transfers</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-btc" />
                  <span>1:1 BTC Backed</span>
                </div>
              </div>

              {/* CTA Button */}
              <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-4">
                <Link
                  href="/bridge"
                  className="btn-bitcoin inline-flex items-center gap-2 px-8 py-4 text-lg"
                >
                  <BitcoinIcon className="w-5 h-5" />
                  Launch Bridge
                  <ArrowRight className="w-5 h-5" />
                </Link>
                <a
                  href="https://docs.zVault.xyz"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-tertiary inline-flex items-center gap-2 px-6 py-4"
                >
                  <Shield className="w-5 h-5" />
                  Learn About Privacy
                </a>
              </div>
            </div>

            {/* Features */}
            <div className="grid md:grid-cols-2 gap-4">
              <FeatureCard
                icon={EyeOff}
                title="Privacy Protected"
                description="Zero-knowledge proofs ensure your transaction amounts and history remain confidential"
                variant="cyber"
              />
              <FeatureCard
                icon={Bitcoin}
                title="1:1 BTC Backed"
                description="Each zkBTC token is fully backed by real Bitcoin locked in escrow"
                variant="bitcoin"
              />
              <FeatureCard
                icon={Zap}
                title="Fast & Efficient"
                description="Quick bridging with automatic confirmation tracking and instant minting"
              />
              <FeatureCard
                icon={ShieldCheck}
                title="OFAC Compliant"
                description="Built-in compliance screening ensures regulatory compliance while preserving privacy"
                variant="cyber"
              />
            </div>

            {/* Stats */}
            <div className="gradient-bg-card p-6 rounded-[16px] w-full">
              <h3 className="text-caption text-gray uppercase tracking-wide mb-4 text-center">
                Bridge Statistics
              </h3>
              <StatsDisplay stats={stats} isLoading={isLoading} />
            </div>

            {/* How it works */}
            <div className="space-y-6">
              <h2 className="text-heading5 text-foreground">How It Works</h2>
              <div className="grid md:grid-cols-3 gap-6">
                {/* Step 1 - Bitcoin */}
                <div className="flex flex-col items-center text-center gap-3 p-5 gradient-bg-bitcoin rounded-[12px]">
                  <div className="w-12 h-12 rounded-full bg-btc/10 border border-btc/20 flex items-center justify-center">
                    <Bitcoin className="w-6 h-6 text-btc btc-glow" />
                  </div>
                  <div>
                    <h3 className="text-body2-semibold text-foreground mb-1">Deposit BTC</h3>
                    <p className="text-caption text-gray">Connect your wallet and send Bitcoin to your unique deposit address</p>
                  </div>
                </div>

                {/* Step 2 - Privacy */}
                <div className="flex flex-col items-center text-center gap-3 p-5 gradient-bg-card privacy-lines rounded-[12px]">
                  <div className="w-12 h-12 rounded-full bg-privacy/10 border border-privacy/20 flex items-center justify-center">
                    <Shield className="w-6 h-6 text-privacy privacy-glow" />
                  </div>
                  <div>
                    <h3 className="text-body2-semibold text-foreground mb-1">Shield with ZK</h3>
                    <p className="text-caption text-gray">Your deposit is shielded using zero-knowledge proofs for privacy</p>
                  </div>
                </div>

                {/* Step 3 - Mint */}
                <div className="flex flex-col items-center text-center gap-3 p-5 gradient-bg-card rounded-[12px]">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-btc/20 to-privacy/20 border border-sol/20 flex items-center justify-center">
                    <Lock className="w-6 h-6 text-sol" />
                  </div>
                  <div>
                    <h3 className="text-body2-semibold text-foreground mb-1">Mint zkBTC</h3>
                    <p className="text-caption text-gray">Receive privacy-protected zkBTC tokens on Solana</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-gray/15">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-2">
              <BitcoinIcon className="w-4 h-4" />
              <span className="text-caption text-btc">Bitcoin</span>
              <span className="text-caption text-gray">+</span>
              <Shield className="w-4 h-4 text-privacy" />
              <span className="text-caption text-privacy">Privacy</span>
              <span className="text-caption text-gray">=</span>
              <span className="text-caption text-foreground">zVault</span>
            </div>
            <p className="text-caption text-gray">
              Demo Version - Testnet Only
            </p>
          </div>
        </footer>
      </div>
    </main>
  );
}
