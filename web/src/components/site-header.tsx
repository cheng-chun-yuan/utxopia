"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Rocket, Menu, X, Settings as SettingsIcon } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { AdvancedModeBadge } from "@/components/ui/advanced-mode-badge";
import { NetworkBadge } from "@/components/ui/network-badge";

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <nav className="fixed top-4 left-0 w-full z-50 flex justify-center px-4">
        <motion.div
          className="nav-pill px-4 py-2 flex items-center transition-all duration-300"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Logo — capybara mark, transparent, floats naturally */}
          <Link href="/" className="flex items-center gap-2.5 group shrink-0">
            <motion.div
              className="relative w-8 h-8 flex items-center justify-center transition-all duration-300 group-hover:drop-shadow-[0_0_8px_rgba(208,173,92,0.4)]"
              whileHover={{ scale: 1.08 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
            >
              <Image
                src="/brand/logo-transparent-128.png"
                alt="UTXOpia"
                width={32}
                height={32}
                priority
                className="h-full w-full object-contain"
              />
            </motion.div>
            <span className="text-sm font-semibold tracking-tight text-foreground group-hover:text-privacy transition-colors">
              UTXOpia
            </span>
          </Link>

          {/* Desktop links */}
          <div className="hidden md:flex items-center justify-center gap-5 flex-1 mx-5">
            {[
              { href: "/explorer", label: "Explorer" },
              { href: "/docs", label: "Docs" },
            ].map(({ href, label }) => (
              <motion.div key={href} whileHover={{ y: -1 }}>
                <Link
                  href={href}
                  className="text-xs font-medium text-gray hover:text-foreground transition-all py-3 px-2"
                >
                  {label}
                </Link>
              </motion.div>
            ))}
          </div>

          {/* Desktop CTA */}
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <NetworkBadge />
            <AdvancedModeBadge />
            <Link
              href="/settings"
              aria-label="Settings"
              className="p-2 rounded-full text-gray hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <SettingsIcon className="w-3.5 h-3.5" />
            </Link>
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Link
                href="/vault"
                className="inline-flex items-center gap-1.5 text-xs font-semibold border border-privacy/10 px-4 py-2.5 rounded-full transition-all text-privacy bg-privacy/10 hover:bg-privacy/10 hover:border-privacy/30 hover:shadow-[0_0_15px_rgba(20,241,149,0.15)]"
              >
                <Rocket className="w-3 h-3" />
                Launch App
              </Link>
            </motion.div>
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden ml-auto p-1.5 rounded-md text-gray hover:text-foreground transition-colors"
          >
            {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </motion.div>
      </nav>

      {/* Mobile menu dropdown */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            {/* Menu panel */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="fixed top-16 left-4 right-4 z-50 md:hidden rounded-2xl border border-gray/10 bg-background/95 backdrop-blur-xl p-4 shadow-xl"
            >
              <div className="space-y-1">
                {[
                  { href: "/vault", label: "Vault" },
                  { href: "/explorer", label: "Explorer" },
                  { href: "/docs", label: "Docs" },
                  { href: "/settings", label: "Settings" },
                ].map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center px-4 py-3 rounded-xl text-sm font-medium text-gray-light hover:text-foreground hover:bg-muted/50 transition-colors"
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
