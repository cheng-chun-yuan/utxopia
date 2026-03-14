"use client";

import { useState } from "react";
import Link from "next/link";
import { Shield, Menu, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";

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
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group shrink-0">
            <motion.div
              className="relative w-7 h-7 flex items-center justify-center rounded-full border border-gray/10 bg-gradient-to-br from-btc/10 to-privacy/10 group-hover:border-privacy/30 transition-all duration-300"
              whileHover={{ scale: 1.1 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
            >
              <BitcoinIcon className="h-3.5 w-3.5 btc-glow" />
              <Shield className="h-2 w-2 text-privacy absolute -bottom-0.5 -right-0.5" />
            </motion.div>
            <span className="text-sm font-semibold tracking-tight text-foreground group-hover:text-privacy transition-colors">
              Private Bitcoin
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
                  className="text-xs font-medium text-gray hover:text-foreground transition-all"
                >
                  {label}
                </Link>
              </motion.div>
            ))}
          </div>

          {/* Desktop CTA */}
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Link
                href="/vault"
                className="inline-flex items-center gap-1.5 text-xs font-semibold border border-btc/10 px-4 py-1.5 rounded-full transition-all text-btc bg-btc/10 hover:bg-btc/10 hover:border-btc/30 hover:shadow-[0_0_15px_rgba(247,147,26,0.15)]"
              >
                <BitcoinIcon className="w-3 h-3" />
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
