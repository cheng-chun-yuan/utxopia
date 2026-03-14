"use client";

import Link from "next/link";
import { Shield } from "lucide-react";
import { motion } from "framer-motion";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";

export function SiteHeader() {
  return (
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
          <span className="text-[13px] font-semibold tracking-tight text-foreground group-hover:text-privacy transition-colors">
            Private Bitcoin
          </span>
        </Link>

        {/* Links */}
        <div className="hidden md:flex items-center justify-center gap-5 flex-1 mx-5">
          {[
            { href: "/explorer", label: "Explorer" },
            { href: "/docs", label: "Docs" },
          ].map(({ href, label }) => (
            <motion.div key={href} whileHover={{ y: -1 }}>
              <Link
                href={href}
                className="text-[11px] font-medium text-gray hover:text-foreground transition-all"
              >
                {label}
              </Link>
            </motion.div>
          ))}
        </div>

        {/* Network badge + CTA */}
        <div className="flex items-center gap-2 shrink-0">
          <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Link
              href="/vault"
              className="hidden md:inline-flex items-center gap-1.5 text-[10px] font-semibold border border-btc/20 px-4 py-1.5 rounded-full transition-all text-btc bg-btc/5 hover:bg-btc/10 hover:border-btc/40 hover:shadow-[0_0_15px_rgba(247,147,26,0.15)]"
            >
              <BitcoinIcon className="w-3 h-3" />
              Launch App
            </Link>
          </motion.div>
        </div>
      </motion.div>
    </nav>
  );
}
