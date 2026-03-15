"use client";

import React, { memo } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Bitcoin, Shield, Zap, Lock, ArrowRight, EyeOff, Fingerprint, ShieldCheck, Loader2, ChevronRight } from "lucide-react";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { usePoolStats } from "@/hooks/use-pool-stats";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { ScrollReveal } from "@/components/ui/scroll-reveal";
import { GradientBorderCard } from "@/components/ui/gradient-border-card";
import { AnimatedCounter } from "@/components/ui/animated-counter";
import { MouseSpotlight } from "@/components/ui/mouse-spotlight";

/* ── Feature visualizations ── */

const PrivacyViz = () => (
  <div className="flex-1 w-full rounded-xl border border-privacy/10 md:border-gray/10 bg-muted/20 flex flex-col items-center justify-center gap-3 p-6 group-hover:border-privacy/15 transition-colors overflow-hidden relative">
    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(20,241,149,0.04),transparent)] md:opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
    <div className="w-full space-y-2.5 z-10">
      {[
        { fromStart: "0xa3", fromMid: "f7e2", fromEnd: "c21b", toStart: "0x91", toMid: "d2b8", toEnd: "e8f4", amt: "0.0042", delay: 0 },
        { fromStart: "0xb8", fromMid: "e1a3", fromEnd: "9a7c", toStart: "0x4d", toMid: "6fc7", toEnd: "2b1e", amt: "0.1500", delay: 100 },
        { fromStart: "0xf2", fromMid: "c9d1", fromEnd: "5d3a", toStart: "0x7e", toMid: "8ba2", toEnd: "a4c6", amt: "0.0831", delay: 200 },
      ].map((row, i) => (
        <div
          key={i}
          className="flex items-center justify-between px-3 py-2 rounded-lg bg-background/40 border border-privacy/10 md:border-gray/5 group-hover:border-privacy/10 transition-all duration-500"
          style={{ transitionDelay: `${row.delay}ms` }}
        >
          <span className="text-[10px] font-mono text-privacy/40 md:text-gray/30 group-hover:text-privacy/40 transition-colors duration-500">
            {row.fromStart}<span className="inline-block blur-[4px] text-privacy/80 md:blur-0 md:text-inherit group-hover:blur-[4px] group-hover:text-privacy/80 transition-all duration-700" style={{ transitionDelay: `${row.delay + 50}ms` }}>{row.fromMid}</span>{row.fromEnd}
          </span>
          <span className="text-[8px] text-privacy/25 md:text-gray/15 group-hover:text-privacy/25 transition-colors">→</span>
          <span className="text-[10px] font-mono text-privacy/40 md:text-gray/30 group-hover:text-privacy/40 transition-colors duration-500">
            {row.toStart}<span className="inline-block blur-[4px] text-privacy/80 md:blur-0 md:text-inherit group-hover:blur-[4px] group-hover:text-privacy/80 transition-all duration-700" style={{ transitionDelay: `${row.delay + 80}ms` }}>{row.toMid}</span>{row.toEnd}
          </span>
          <span className="text-[10px] font-mono text-privacy/80 blur-[4px] md:blur-0 md:text-gray/30 group-hover:text-privacy/80 group-hover:blur-[4px] transition-all duration-700" style={{ transitionDelay: `${row.delay + 100}ms` }}>{row.amt}</span>
        </div>
      ))}
    </div>
    <div className="flex items-center gap-2 z-10 mt-1">
      <div className="w-1.5 h-1.5 rounded-full bg-privacy/60 md:bg-privacy/30 group-hover:bg-privacy/60 group-hover:animate-pulse transition-all duration-500" />
      <span className="text-[9px] font-mono text-privacy/40 md:text-gray/20 group-hover:text-privacy/40 transition-colors duration-500">addresses & amounts hidden by ZK proof</span>
    </div>
  </div>
);

const BackedViz = () => (
  <div className="flex-1 w-full rounded-xl border border-btc/10 md:border-gray/10 bg-muted/20 flex flex-col items-center justify-center gap-4 p-6 group-hover:border-btc/15 transition-colors relative overflow-hidden">
    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(247,147,26,0.04),transparent)] md:opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
    <div className="flex items-center gap-6 z-10">
      <div className="flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-2xl border border-btc/25 md:border-gray/10 bg-background/40 flex items-center justify-center group-hover:border-btc/25 transition-all duration-500">
          <Bitcoin className="w-7 h-7 text-btc/70 md:text-gray/20 group-hover:text-btc/70 transition-all duration-500" />
        </div>
        <span className="text-[10px] font-mono text-btc/50 md:text-gray/25 group-hover:text-btc/50 transition-colors duration-500">1 BTC</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="w-2 h-0.5 rounded-full bg-btc/40 md:bg-gray/10 group-hover:bg-btc/40 transition-all duration-500" style={{ transitionDelay: `${i * 80}ms` }} />
          ))}
          <Lock className="w-3.5 h-3.5 text-btc/50 md:text-gray/15 group-hover:text-btc/50 transition-all duration-500" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="w-2 h-0.5 rounded-full bg-btc/40 md:bg-gray/10 group-hover:bg-btc/40 transition-all duration-500" style={{ transitionDelay: `${(i + 3) * 80}ms` }} />
          ))}
        </div>
        <span className="text-[8px] text-btc/30 md:text-gray/15 group-hover:text-btc/30 transition-colors duration-500">escrow</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="w-14 h-14 rounded-2xl border border-btc/25 md:border-gray/10 bg-background/40 flex items-center justify-center group-hover:border-btc/25 transition-all duration-500">
          <Shield className="w-7 h-7 text-btc/70 md:text-gray/20 group-hover:text-btc/70 transition-all duration-500" />
        </div>
        <span className="text-[10px] font-mono text-btc/50 md:text-gray/25 group-hover:text-btc/50 transition-colors duration-500">1 zkBTC</span>
      </div>
    </div>
    <div className="flex items-center gap-2 z-10">
      <span className="text-[9px] font-mono text-btc/40 md:text-gray/20 group-hover:text-btc/40 transition-colors duration-500">fully collateralized 1:1</span>
    </div>
  </div>
);

const SpeedViz = () => (
  <div className="flex-1 w-full rounded-xl border border-sol/10 md:border-gray/10 bg-muted/20 flex flex-col items-center justify-center gap-4 p-6 group-hover:border-sol/15 transition-colors relative overflow-hidden">
    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(153,69,255,0.04),transparent)] md:opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
    <div className="w-full space-y-3 z-10">
      {[
        { label: "Confirmation", value: "~400ms", pct: 95 },
        { label: "Proof Gen", value: "~2.1s", pct: 70 },
        { label: "Settlement", value: "instant", pct: 100 },
      ].map((metric, i) => (
        <div key={metric.label} className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-sol/40 md:text-gray/25 group-hover:text-sol/40 transition-colors duration-500" style={{ transitionDelay: `${i * 80}ms` }}>{metric.label}</span>
            <span className="text-[10px] font-mono text-sol/50 md:text-gray/20 group-hover:text-sol/50 transition-colors duration-500" style={{ transitionDelay: `${i * 80}ms` }}>{metric.value}</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-background/40 overflow-hidden">
            <div
              className="h-full rounded-full bg-sol/40 md:bg-gray/10 group-hover:bg-sol/40 transition-all duration-700 ease-out"
              style={{ width: `0%`, transitionDelay: `${i * 120}ms` }}
              ref={(el) => {
                if (el) {
                  const obs = new IntersectionObserver(([e]) => {
                    if (e.isIntersecting) { el.style.width = `${metric.pct}%`; obs.disconnect(); }
                  }, { threshold: 0.3 });
                  obs.observe(el);
                }
              }}
            />
          </div>
        </div>
      ))}
    </div>
    <div className="flex items-center gap-2 z-10 mt-1">
      <Zap className="w-3 h-3 text-sol/50 md:text-gray/20 group-hover:text-sol/50 transition-colors duration-500" />
      <span className="text-[9px] font-mono text-sol/40 md:text-gray/20 group-hover:text-sol/40 transition-colors duration-500">Solana 65k TPS</span>
    </div>
  </div>
);

const ComplianceViz = () => (
  <div className="flex-1 w-full rounded-xl border border-cyan/10 md:border-gray/10 bg-muted/20 flex flex-col items-center justify-center gap-3 p-6 group-hover:border-cyan/15 transition-colors relative overflow-hidden">
    <div className="absolute inset-0 md:opacity-0 group-hover:opacity-100 transition-opacity duration-300">
      <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-r from-transparent via-cyan/5 to-transparent animate-[sweep_2s_ease-in-out_infinite] md:animate-none group-hover:animate-[sweep_2s_ease-in-out_infinite]" />
    </div>
    <div className="w-full space-y-2.5 z-10">
      {[
        { label: "Address Screening", status: "pass", checked: true },
        { label: "Amount Validation", status: "pass", checked: true },
        { label: "OFAC SDN List", status: "pending", checked: false },
      ].map((item, i) => (
        <div
          key={item.label}
          className="flex items-center justify-between px-3 py-2 rounded-lg bg-background/40 border border-cyan/10 md:border-gray/5 group-hover:border-cyan/10 transition-all duration-500"
          style={{ transitionDelay: `${i * 100}ms` }}
        >
          <div className="flex items-center gap-2">
            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all duration-500 ${
              item.checked
                ? "border-cyan/40 bg-cyan/15 md:border-gray/15 md:bg-transparent group-hover:border-cyan/40 group-hover:bg-cyan/15"
                : "border-gray/20 md:border-gray/10 group-hover:border-gray/20"
            }`}>
              {item.checked && (
                <span className="text-[8px] text-cyan/70 md:text-transparent group-hover:text-cyan/70 transition-colors duration-500" style={{ transitionDelay: `${i * 150 + 200}ms` }}>✓</span>
              )}
            </div>
            <span className="text-[10px] font-mono text-gray/45 md:text-gray/25 group-hover:text-gray/45 transition-colors duration-500">{item.label}</span>
          </div>
          <span className={`text-[8px] font-mono transition-colors duration-500 ${
            item.checked
              ? "text-cyan/40 md:text-gray/15 group-hover:text-cyan/40"
              : "text-gray/25 md:text-gray/10 group-hover:text-gray/25"
          }`}>{item.status}</span>
        </div>
      ))}
    </div>
    <div className="flex items-center gap-2 z-10 mt-1">
      <ShieldCheck className="w-3 h-3 text-cyan/50 md:text-gray/20 group-hover:text-cyan/50 transition-colors duration-500" />
      <span className="text-[9px] font-mono text-cyan/40 md:text-gray/20 group-hover:text-cyan/40 transition-colors duration-500">regulatory compliance layer</span>
    </div>
  </div>
);

const FeatureCard = memo(function FeatureCard({
  icon: Icon, title, description, iconColor, hoverGlow, step, visualization: Viz,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  iconColor: string;
  hoverGlow: string;
  step: string;
  visualization: React.ComponentType;
}) {
  return (
    <GradientBorderCard hoverGlow={hoverGlow} step={step} className="group h-full">
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 mb-1.5">
          <div className="p-2 rounded-lg border border-gray/10 bg-muted/30 group-hover:border-privacy/20 transition-colors shrink-0">
            <Icon className={`w-4 h-4 ${iconColor} md:text-gray group-hover:${iconColor} transition-colors`} />
          </div>
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
        </div>
        <p className="text-sm text-gray-light md:text-gray font-light mb-4 group-hover:text-gray-light transition-colors leading-relaxed">{description}</p>
        <Viz />
      </div>
    </GradientBorderCard>
  );
});
FeatureCard.displayName = "FeatureCard";

/* ── Main Page ── */
export default function Home() {
  const { stats, isLoading } = usePoolStats();

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay overflow-x-hidden">
      <MouseSpotlight />
      <SiteHeader />

      <div className="relative z-10">
        {/* ═══════════════ HERO ═══════════════ */}
        <section className="min-h-[85vh] flex flex-col items-center justify-center px-4 pt-28 pb-16 relative">
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-[10%] left-[15%] w-[500px] h-[500px] rounded-full bg-btc/4 blur-[150px]" />
            <div className="absolute bottom-[5%] right-[10%] w-[400px] h-[400px] rounded-full bg-sol/3 blur-[150px]" />
            <div className="absolute top-[40%] left-[50%] -translate-x-1/2 w-[600px] h-[300px] rounded-full bg-purple/3 blur-[120px]" />
          </div>

          <div className="max-w-4xl mx-auto text-center relative z-10">
            <ScrollReveal delay={0}>
              <div className="flex items-center justify-center mb-5">
                <motion.div
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple/10 border border-purple/20 backdrop-blur-sm cursor-default hover:border-purple/40 transition-all duration-300"
                  whileHover={{ scale: 1.05 }}
                >
                  <img src="/zeus_network.svg" alt="Zeus" className="w-4 h-4" />
                  <span className="text-caption">
                    <span className="text-gray-light">Powered by</span>{" "}
                    <span className="text-purple">Zeus Network</span>
                  </span>
                </motion.div>
              </div>
            </ScrollReveal>

            <ScrollReveal delay={0.1}>
              <h1 className="hero-title text-foreground">
                Bitcoin. <span className="text-btc">Shielded.</span>
              </h1>
            </ScrollReveal>

            <ScrollReveal delay={0.15}>
              <p className="mt-6 text-base md:text-lg text-gray font-light max-w-md mx-auto leading-relaxed">
                Shield BTC on Solana with ZK proofs. 1:1 backed. Fully private.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={0.2}>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-caption text-gray">
                <div className="flex items-center gap-1.5">
                  <EyeOff className="w-4 h-4 text-btc" />
                  <span>Hidden Amounts</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Fingerprint className="w-4 h-4 text-sol" />
                  <span>Anonymous Transfers</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-privacy" />
                  <span>1:1 BTC Backed</span>
                </div>
              </div>
            </ScrollReveal>

            <ScrollReveal delay={0.25}>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.97 }}>
                  <Link
                    href="/vault"
                    className="btn-bitcoin btn-pill btn-shimmer inline-flex items-center gap-2 px-7 py-2.5 text-base shadow-[0_0_20px_rgba(247,147,26,0.2)] hover:shadow-[0_0_35px_rgba(247,147,26,0.4)] transition-shadow"
                  >
                    <BitcoinIcon className="w-5 h-5" />
                    Launch Vault
                    <ArrowRight className="w-5 h-5" />
                  </Link>
                </motion.div>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.97 }}>
                  <Link
                    href="/docs"
                    className="btn-tertiary btn-pill inline-flex items-center gap-2 px-5 py-2.5 border border-gray/10 backdrop-blur-md hover:bg-muted/50 hover:border-gray/20 transition-all"
                  >
                    <Shield className="w-4 h-4" />
                    Learn More
                  </Link>
                </motion.div>
              </div>
            </ScrollReveal>

            <ScrollReveal delay={0.3}>
              <div className="pt-8 border-t border-gray/10 mt-8">
                {isLoading ? (
                  <div className="flex items-center justify-center py-2">
                    <Loader2 className="w-5 h-5 animate-spin text-gray/40" />
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-8">
                    {[
                      { label: "Vault (BTC)", value: Number(stats?.totalShielded ?? 0n) / 1e8, decimals: 4, color: "text-privacy", icon: <Shield className="w-4 h-4 text-privacy privacy-glow" /> },
                      { label: "Leaves", value: stats?.totalCommitments ?? 0, decimals: 0, color: "text-foreground", icon: null },
                      { label: "Volume (BTC)", value: Number(stats?.volume ?? 0n) / 1e8, decimals: 4, color: "text-foreground", icon: null },
                    ].map(({ label, value, decimals, color, icon }, i) => (
                      <React.Fragment key={label}>
                        {i > 0 && <div className="w-px h-8 bg-gradient-to-b from-transparent via-gray/20 to-transparent" />}
                        <div className="text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            {icon}
                            <AnimatedCounter value={value} decimals={decimals} className={`text-2xl font-semibold tracking-tight ${color}`} />
                          </div>
                          <div className="text-xs text-gray">{label}</div>
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            </ScrollReveal>
          </div>
        </section>

        {/* ═══════════════ HOW IT WORKS — Original bento cards ═══════════════ */}
        <section className="w-full py-20 px-4 sm:px-6 lg:px-8 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-muted/5 to-transparent pointer-events-none" />
          <div className="absolute top-[10%] right-[-5%] w-[40%] h-[40%] rounded-full bg-privacy/3 blur-[100px] pointer-events-none" />
          <div className="absolute bottom-[10%] left-[-5%] w-[35%] h-[35%] rounded-full bg-btc/3 blur-[100px] pointer-events-none" />

          <div className="max-w-7xl mx-auto relative z-10">
            <ScrollReveal>
              <div className="text-center mb-12">
                <h2 className="section-title text-3xl md:text-4xl text-foreground mb-3">
                  How It <span className="text-btc">Works</span>
                </h2>
                <p className="text-sm text-gray font-light">
                  Four layers of protection for your Bitcoin on Solana.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6 auto-rows-fr">
              <FeatureCard icon={EyeOff} title="ZK Private" description="Amounts & addresses hidden by zero-knowledge proofs" iconColor="text-privacy" hoverGlow="rgba(20, 241, 149, 0.12)" step="01" visualization={PrivacyViz} />
              <FeatureCard icon={Bitcoin} title="1:1 Backed" description="Every zkBTC backed by real Bitcoin in escrow" iconColor="text-btc" hoverGlow="rgba(247, 147, 26, 0.12)" step="02" visualization={BackedViz} />
              <FeatureCard icon={Zap} title="Instant" description="Auto-confirmed deposits, sub-second settlement" iconColor="text-sol" hoverGlow="rgba(153, 69, 255, 0.12)" step="03" visualization={SpeedViz} />
              <FeatureCard icon={ShieldCheck} title="Compliant" description="OFAC screening without compromising privacy" iconColor="text-cyan" hoverGlow="rgba(0, 255, 255, 0.08)" step="04" visualization={ComplianceViz} />
            </div>
          </div>
        </section>

        {/* ═══════════════ CTA ═══════════════ */}
        <section className="w-full py-20 px-4 sm:px-6 relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none opacity-20">
            <div className="absolute top-[30%] left-[30%] w-[500px] h-[500px] rounded-full blur-[120px] rotate-glow origin-center bg-privacy/5 mix-blend-screen" />
            <div className="absolute bottom-[30%] right-[30%] w-[500px] h-[500px] rounded-full blur-[120px] rotate-glow-reverse origin-center bg-btc/5 mix-blend-screen" />
          </div>

          <div className="max-w-3xl mx-auto text-center relative z-10">
            <ScrollReveal variant="scaleIn">
              <h2 className="section-title text-3xl md:text-4xl text-foreground mb-4">
                Start <span className="text-btc">Shielding</span>
              </h2>
              <p className="text-base text-gray font-light mb-8">
                Deposit BTC. Get zkBTC. Stay private.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.97 }}>
                  <Link
                    href="/vault"
                    className="btn-bitcoin btn-pill btn-shimmer inline-flex items-center gap-2 px-7 py-2.5 text-base shadow-[0_0_20px_rgba(247,147,26,0.2)] hover:shadow-[0_0_35px_rgba(247,147,26,0.4)] transition-shadow"
                  >
                    <BitcoinIcon className="w-5 h-5" />
                    Launch Vault
                    <ArrowRight className="w-5 h-5" />
                  </Link>
                </motion.div>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.97 }}>
                  <Link
                    href="/explorer"
                    className="btn-tertiary btn-pill inline-flex items-center gap-2 px-5 py-2.5 border border-gray/10 backdrop-blur-md hover:bg-muted/50 hover:border-gray/20 transition-all"
                  >
                    View Explorer
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                </motion.div>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
