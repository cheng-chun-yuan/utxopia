"use client";

import Link from "next/link";
import {
  Shield,
  EyeOff,
  Lock,
  Key,
  Fingerprint,
  Bitcoin,
  ArrowRight,
  ArrowLeft,
  Zap,
  ShieldCheck,
  Search,
} from "lucide-react";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";

const steps = [
  {
    number: 1,
    title: "Deposit BTC",
    description:
      "Send Bitcoin to a unique Taproot address generated from your stealth keys. Any amount, one transaction.",
    icon: Bitcoin,
    color: "btc",
    bgClass: "bg-btc/10",
    borderClass: "border-btc/20",
    textClass: "text-btc",
  },
  {
    number: 2,
    title: "Shield with ZK",
    description:
      "Your deposit becomes a hidden Poseidon commitment inserted into a Merkle tree. The amount disappears from public view.",
    icon: Shield,
    color: "privacy",
    bgClass: "bg-privacy/10",
    borderClass: "border-privacy/20",
    textClass: "text-privacy",
  },
  {
    number: 3,
    title: "Transact Privately",
    description:
      "JoinSplit proofs let you transfer to anyone without revealing amounts, senders, or recipients.",
    icon: Lock,
    color: "purple",
    bgClass: "bg-purple/10",
    borderClass: "border-purple/20",
    textClass: "text-purple",
  },
  {
    number: 4,
    title: "Withdraw to BTC",
    description:
      "Burn your private note and receive BTC back via FROST threshold signing. No single party controls your funds.",
    icon: ArrowRight,
    color: "cyan",
    bgClass: "bg-cyan/10",
    borderClass: "border-cyan/20",
    textClass: "text-cyan",
  },
] as const;

const features = [
  {
    icon: EyeOff,
    title: "Shielded-Only",
    description:
      "No public zkBTC token ever exists. Your BTC lives only as cryptographic commitments.",
    variant: "cyber" as const,
  },
  {
    icon: Shield,
    title: "Zero-Knowledge Proofs",
    description:
      "Groth16 proofs (256 bytes) verify every transfer without revealing amounts or parties.",
    variant: "privacy" as const,
  },
  {
    icon: Fingerprint,
    title: "Stealth Addresses",
    description:
      "One-time addresses ensure recipients can\u2019t be linked across transactions.",
    variant: "default" as const,
  },
  {
    icon: Key,
    title: "3-Key Architecture",
    description:
      "Separate spending, nullifying, and viewing keys. Share your viewing key for compliance without spending risk.",
    variant: "bitcoin" as const,
  },
] as const;

const technicalDetails = [
  {
    label: "Commitment",
    code: "Poseidon(npk, token, amount)",
    description: "a hiding hash of your note",
  },
  {
    label: "Nullifier",
    code: "Poseidon(nullifyingKey, leafIndex)",
    description: "prevents double-spending without revealing which note was spent",
  },
  {
    label: "Merkle Tree",
    code: "Depth 16, Poseidon hashing",
    description: "supports 65,536 private notes",
  },
  {
    label: "JoinSplit(N,M)",
    code: "N inputs \u2192 M outputs",
    description: "all verified by a single ZK proof",
  },
  {
    label: "FROST Signing",
    code: "t-of-n threshold",
    description: "trustless BTC withdrawals \u2014 no single party controls funds",
  },
];

const securityItems = [
  { icon: Zap, text: "Permissionless \u2014 no KYC required to deposit or transact privately" },
  { icon: ShieldCheck, text: "Trustless \u2014 BTC verified via SPV proofs on Solana, no custodian" },
  { icon: Key, text: "Self-custody \u2014 only you hold the keys to your private notes" },
  { icon: Shield, text: "OFAC Compliant \u2014 built-in screening at deposit to ensure regulatory compliance" },
];

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

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay">
      <div className="container mx-auto px-4 py-8 relative z-10 max-w-5xl">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <div className="p-2 rounded-[12px] bg-linear-to-br from-btc/20 to-privacy/20 border border-btc/20">
                <div className="relative">
                  <BitcoinIcon className="h-6 w-6 btc-glow" />
                  <Shield className="h-3 w-3 text-privacy absolute -bottom-1 -right-1" />
                </div>
              </div>
              <span className="text-heading6 text-foreground">Private Bitcoin</span>
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/explorer"
              className="text-body2 text-gray hover:text-gray-light transition-colors flex items-center gap-1"
            >
              Explorer
              <Search className="w-3 h-3" />
            </Link>
            <Link
              href="/vault"
              className="text-body2 text-gray hover:text-gray-light transition-colors"
            >
              Vault
            </Link>
          </div>
        </header>

        {/* Content */}
        <div className="max-w-4xl mx-auto space-y-10">
          {/* Back link */}
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-body2 text-gray hover:text-gray-light transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>

          {/* Main card */}
          <div className="bg-card/80 backdrop-blur-sm border border-gray/30 rounded-[16px] glow-border cyber-corners p-5 sm:p-8 md:p-10 space-y-8 sm:space-y-10">
            {/* 1. Welcome Hero */}
            <section className="space-y-4 text-center">
              <div className="flex justify-center">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-privacy/10 border border-privacy/20">
                  <Shield className="w-4 h-4 text-privacy" />
                  <span className="text-caption text-privacy">Privacy Documentation</span>
                </div>
              </div>
              <h1 className="text-3xl md:text-4xl font-bold text-foreground">
                Privacy on zkBTC
              </h1>
              <p className="text-body1 text-gray-light">
                One protocol for private Bitcoin on Solana
              </p>
              <p className="text-body2 text-gray max-w-lg mx-auto">
                Private Bitcoin lets you deposit BTC and transact privately on Solana using
                zero-knowledge proofs. No public tokens, no traceable amounts, no
                linked addresses.
              </p>
            </section>

            <div className="border-t border-gray/15" />

            {/* 2. Why Privacy Matters */}
            <section className="space-y-4">
              <h2 className="text-heading5 text-foreground">Why Privacy Matters</h2>
              <div className="bitcoin-box rounded-[12px] p-6 space-y-3">
                <ul className="space-y-2.5 text-body2 text-gray">
                  <li className="flex items-start gap-2">
                    <span className="text-btc mt-1 shrink-0">&bull;</span>
                    Bitcoin transactions are fully public &mdash; anyone can trace your balance and history
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-btc mt-1 shrink-0">&bull;</span>
                    Addresses can be linked to your identity through exchanges and analytics
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-btc mt-1 shrink-0">&bull;</span>
                    Payment amounts are visible to everyone on the blockchain
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-btc mt-1 shrink-0">&bull;</span>
                    Without privacy, financial surveillance is the default
                  </li>
                </ul>
              </div>
            </section>

            <div className="border-t border-gray/15" />

            {/* 3. How Private Bitcoin Works */}
            <section className="space-y-6">
              <h2 className="text-heading5 text-foreground">How Private Bitcoin Works</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {steps.map((step) => {
                  const Icon = step.icon;
                  return (
                    <div
                      key={step.number}
                      className="flex items-start gap-4 p-4 rounded-[12px] bg-card/50 border border-gray/15"
                    >
                      <div
                        className={`w-10 h-10 rounded-full ${step.bgClass} border ${step.borderClass} flex items-center justify-center shrink-0`}
                      >
                        <Icon className={`w-5 h-5 ${step.textClass}`} />
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-caption font-mono ${step.textClass}`}
                          >
                            Step {step.number}
                          </span>
                          <h3 className="text-body2-semibold text-foreground">
                            {step.title}
                          </h3>
                        </div>
                        <p className="text-body2 text-gray">{step.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="border-t border-gray/15" />

            {/* 4. Privacy Features */}
            <section className="space-y-6">
              <h2 className="text-heading5 text-foreground">Privacy Features</h2>
              <div className="grid sm:grid-cols-2 gap-4">
                {features.map((feature) => {
                  const Icon = feature.icon;
                  const style = variantStyles[feature.variant];
                  return (
                    <div
                      key={feature.title}
                      className={`p-6 rounded-[16px] ${style.cardClass} space-y-3 text-left`}
                    >
                      <div className="flex justify-start">
                        <div className={`p-3 rounded-[12px] ${style.iconBg}`}>
                          <Icon className={`h-6 w-6 ${style.iconColor}`} />
                        </div>
                      </div>
                      <h3 className="text-heading6 text-foreground">
                        {feature.title}
                      </h3>
                      <p className="text-body2 text-gray">{feature.description}</p>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="border-t border-gray/15" />

            {/* 5. Under the Hood */}
            <section className="space-y-6">
              <h2 className="text-heading5 text-foreground">Under the Hood</h2>
              <div className="gradient-bg-card rounded-[16px] p-6 space-y-4">
                {technicalDetails.map((item) => (
                  <div key={item.label} className="space-y-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-body2-semibold text-foreground">
                        {item.label}
                      </span>
                      <code className="font-mono text-xs bg-muted/50 px-2 py-1 rounded text-privacy">
                        {item.code}
                      </code>
                    </div>
                    <p className="text-caption text-gray">{item.description}</p>
                  </div>
                ))}
              </div>
            </section>

            <div className="border-t border-gray/15" />

            {/* 6. Security & Compliance */}
            <section className="space-y-4">
              <h2 className="text-heading5 text-foreground">
                Security &amp; Compliance
              </h2>
              <div className="privacy-box rounded-[12px] p-6 space-y-3">
                {securityItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.text} className="flex items-start gap-3">
                      <Icon className="w-4 h-4 text-privacy mt-0.5 shrink-0" />
                      <span className="text-body2 text-gray">{item.text}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="border-t border-gray/15" />

            {/* 7. CTA */}
            <section className="text-center space-y-4">
              <h2 className="text-heading5 text-foreground">
                Ready to get started?
              </h2>
              <Link
                href="/vault"
                className="btn-bitcoin inline-flex items-center gap-2 px-8 py-4 text-lg"
              >
                <BitcoinIcon className="w-5 h-5" />
                Launch App
                <ArrowRight className="w-5 h-5" />
              </Link>
            </section>
          </div>

          {/* 8. Footer */}
          <footer className="pt-8 border-t border-gray/15">
            <div className="flex flex-col md:flex-row justify-between items-center gap-4">
              <div className="flex items-center gap-4">
                <Link
                  href="/"
                  className="text-caption text-gray hover:text-gray-light transition-colors"
                >
                  Private Bitcoin
                </Link>
              </div>
              <a href="https://zeusnetwork.xyz/" target="_blank" rel="noopener noreferrer" className="text-caption text-gray hover:text-gray-light transition-colors flex items-center gap-1.5">
                Powered by <img src="/zeus_network.svg" alt="Zeus Network" className="w-4 h-4" />Zeus Network
              </a>
            </div>
          </footer>
        </div>
      </div>
    </main>
  );
}
